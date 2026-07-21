# paperhanger 仕様書

アラート(Grafana 等)を起点にログ・トレース・メトリクスを自動収集し、
[Flue Framework](https://flueframework.com/) のエージェントで根本原因を診断して、
対象リポジトリへ修正 PR を自動作成するサービス。

## 1. ゴール / 非ゴール

### ゴール

- アラート発火から人手ゼロで「診断レポート付きの修正 PR」が上がる状態を作る
- 受信ソース・テレメトリ取得元・通知先・永続化をすべて抽象化し、実装を差し替え可能にする
- コンテナイメージとして配布し、どの環境(K8s / compose / VM)でも動かせる

### 非ゴール

- 自動マージ・自動デプロイ(人間の判断は PR レビューで行う)
- インフラ緩和操作の自動実行(rollout restart 等)
- アラートのポーリング取得(受信は Webhook のみ)

## 2. 全体フロー

```
Webhook 受信 → 正規化 → 重複制御 → テレメトリ収集 → リポジトリ解決
  → Flue エージェント(診断 → 修正 → テスト → PR 作成) → 通知
```

インシデントの状態遷移:

```
received → collecting → resolving_repo → diagnosing → fixing
  → pr_created | report_only | failed | skipped
```

- `pr_created`: 修正 PR を作成した
- `report_only`: コード修正では直らないと診断(インフラ/設定/データ起因など)。診断レポートのみ通知
- `failed`: エージェントが原因特定・修正に失敗(理由付き)
- `skipped`: 重複・クールダウン・解決対象外で処理せず

## 3. コンポーネント設計

### 3.1 Ingest(受信層)

- `Bun.serve()` による HTTP サーバー
- `POST /webhooks/{source}` で受信。`source` ごとに `SourceAdapter` が payload を共通形式に正規化
- 初期実装アダプタ: **grafana**(Grafana Alerting webhook)、**alertmanager**、**generic**(内部形式をそのまま受ける)
- 将来: Sentry 等を adapter 追加のみで対応
- 認証: ソースごとの共有シークレット(ヘッダ or クエリトークン)。不一致は 401

```ts
interface SourceAdapter {
  readonly name: string;
  parse(req: Request): Promise<IncidentEvent[]>; // 1 webhook に複数アラートが載るケースに対応
}

interface IncidentEvent {
  fingerprint: string;          // ソース提供 or labels のハッシュ
  source: string;               // "grafana" など
  status: "firing" | "resolved";
  severity: string;             // critical / warning / info(ソース値を正規化)
  title: string;
  description?: string;
  labels: Record<string, string>;      // service, namespace, pod など
  annotations: Record<string, string>; // runbook_url, repository など
  startsAt: string;             // ISO 8601
  endsAt?: string;
  generatorUrl?: string;        // アラートルールへのリンク
  raw: unknown;                 // 元 payload(監査用に保存)
}
```

### 3.2 Incident Manager(重複制御・ライフサイクル)

- `fingerprint` 単位でインシデントを一意化
- **dedup**: 同一 fingerprint の open インシデントが存在する場合、イベントを紐付けるだけで新規処理は起こさない
- **クールダウン**: 終了(pr_created / report_only / failed)後、同一 fingerprint はデフォルト 24h スキップ(設定可)
- `resolved` イベント: 進行中の処理は中断せず続行し、インシデントに解決時刻を記録(v1)。未着手なら `skipped`
- **同時実行制御**: エージェント同時実行数の上限(デフォルト 2)。超過分はキューイング
- **競合安全性**: 同一 fingerprint のイベント処理はプロセス内で直列化し、さらにストア側の部分ユニークインデックス(open インシデント × fingerprint)で二重作成を防止
- **再起動リカバリ**: 起動時に非終端ステータスのインシデントを再キューする(パイプラインは先頭から再実行。`diagnosis_started` 通知が重複し得ることは許容)

### 3.3 Storage(永続化・抽象化)

- `IncidentStore` インターフェースで抽象化。**SQLite(`bun:sqlite`)と PostgreSQL(`Bun.sql`)の両実装**を提供
- 単一インスタンス運用は SQLite(volume マウント)、レプリカ構成は PostgreSQL
- 主なテーブル: `incidents`(状態・PR リンク・診断結果)、`incident_events`(受信イベント履歴・raw payload)、`agent_runs`(エージェント実行履歴・コスト)

### 3.4 Telemetry Collector(テレメトリ収集・抽象化)

- `TelemetrySource` インターフェースで抽象化。**初期実装は GreptimeDB 直クエリのみ**

```ts
interface TelemetryQuery {
  timeRange: { from: string; to: string }; // アラート時刻の前 30 分〜後 5 分(デフォルト、設定可)
  labels: Record<string, string>;          // service.name 等でのフィルタ
  limit?: number;
}

interface TelemetrySource {
  readonly name: string;
  queryLogs(q: TelemetryQuery): Promise<LogRecord[]>;
  queryTraces(q: TelemetryQuery): Promise<TraceRecord[]>;
  queryMetrics(q: TelemetryQuery & { promql?: string }): Promise<MetricSeries[]>;
}
```

- GreptimeDB 実装: HTTP SQL API(logs/traces)+ PromQL 互換 API(metrics)
- **収集戦略**(自動収集フェーズ):
  1. アラートのラベルから `service.name` 等を特定し、時間窓内のエラーログを取得(特定できない場合は時間窓のみで件数を絞って取得)
  2. エラーログに紐づく `trace_id` から代表トレースを取得。加えてサービスの代表的なスパンもサンプリング取得
  3. **メトリクスはアラートの `annotations` に `promql` または `metric` キーがある場合のみ取得**。無ければ取得自体を行わず、その旨を notes に記録するのみ
  4. 収集結果がトークン予算を超える場合、優先度の低いものから順に削減(メトリクス→トレース→非例外ログ→例外/スタックトレースを含むログ)。スタックトレース・例外メッセージらしさの判定は独立した抽出ステップではなく、この削減時の優先度判定にのみ使う
- 収集結果はトークン予算内に収まるようサンプリング・要約して `IncidentContext` に整形
- さらに **Flue の Tool としても公開**し、エージェントが診断中に追加クエリを発行できるようにする(将来: Loki/Tempo/Prometheus 実装を追加)

### 3.5 Repo Resolver(修正対象リポジトリの解決)

優先順位でフォールバック:

1. **attribute 指定**: アラートの annotation / テレメトリの resource attribute(例: `service.repository = "owner/repo"`)
2. **マッピング設定**: 設定ファイルのラベルマッチャー → リポジトリ対応表
3. **GitHub org 動的探索**: サービス名等で org 内リポジトリを検索。確信度が低い場合は修正せず `report_only` にフォールバック(誤爆防止)

### 3.6 Fix Agent(Flue エージェント)

- Flue の `defineAgent` + Workflow で実装。**Durable Execution** により中断・障害から再開可能
- モデルは Flue の model 指定子を設定で切替(デフォルト: Anthropic Claude)
- 実行手順:
  1. `IncidentContext`(アラート + 収集済みテレメトリ)を入力
  2. Sandbox 内で対象リポジトリを clone(GitHub App の installation token)
  3. 原因仮説 → コード調査(必要ならテレメトリ Tool で追加クエリ)→ 根本原因の特定
  4. コード起因なら修正 → ビルド・テスト実行
  5. ブランチ `paperhanger/incident-{id}` へ push → PR 作成
  6. PR 本文: 診断サマリ / 根拠となるテレメトリ(ログ・トレース抜粋)/ アラートへのリンク / 修正内容の説明
- **ガードレール**:
  - 変更可能行数の上限(設定可。push 後に GitHub compare API で実差分を検証し、エージェントの自己申告は信用しない)
  - 変更禁止パス(`.github/workflows/`、secrets、CI 設定等)。違反時はリモートブランチを削除して `failed`
  - テストが通らない場合は PR を出さず `failed`(診断レポートは通知)。修正試行回数は `maxFixAttempts`(デフォルト 3)で上限
  - 1 インシデントあたりのタイムアウト(注: タイムアウト時に agent-host 側の実行を取り消す API が Flue SDK に存在しないため、サーバー側で実行が継続し得ることを failureReason に明記する)
  - トークン/コスト予算の直接制御は SDK がワークフロー単位の使用量を公開するまで**未実装**。コスト抑制はタイムアウト+試行回数上限+同時実行上限+クールダウンの組合せで行う
  - PR は draft として作成するオプション
- **セキュリティ対策**(プロンプトインジェクション経由の資格情報悪用への防御):
  - clone 直後(モデルのターン開始前)に origin remote から token を除去。push は token 入り URL を直接引数で渡し、設定に永続化しない
  - commit/push 直前に origin URL・ブランチ名の改ざん検査を行い、不一致は `failed`
  - モデルが生成する全出力(diagnosis / report / commitMessage / failureReason)に token・テレメトリ認証情報のリダクションを一括適用
  - `query_telemetry` ツールは単文の SELECT/SHOW/DESC のみ許可

### 3.7 GitHub Integration

- **GitHub App** として認証(App ID + private key → installation token)
- PR 作成者は App の bot 名義。ラベル(例: `automated-fix`, `paperhanger`)を付与
- 必要権限: Contents (read/write), Pull requests (read/write), Metadata (read)。org 探索を使う場合は org レベルにインストール

### 3.8 Notifier(通知・抽象化)

- `Notifier` インターフェースで抽象化。実装: **Slack Incoming Webhook / Discord Webhook / 汎用 Webhook(JSON POST)**
- 承認ゲートは設けない(人間の判断は PR レビュー)
- 通知タイミング:
  - 診断開始(インシデント概要)
  - PR 作成(PR リンク + 診断サマリ)
  - `report_only`(診断レポート本文)
  - `failed` / `skipped`(理由)

### 3.9 設定

- 設定ファイル: `paperhanger.yaml`(コンテナにマウント)。シークレットは環境変数参照(`${ENV_VAR}` 展開)
- 起動時にスキーマバリデーション(不正なら起動失敗)

```yaml
server:
  port: 8080
  apiToken: ${PAPERHANGER_API_TOKEN}   # auth for GET /incidents; endpoints return 401 when unset (secure by default)
storage: { driver: sqlite, path: /data/paperhanger.db }   # or driver: postgres, url: ${DATABASE_URL}
sources:
  grafana: { secret: ${GRAFANA_WEBHOOK_SECRET} }
  alertmanager: { secret: ${AM_WEBHOOK_SECRET} }
telemetry:
  source: greptimedb          # discriminated union; future sources (loki/tempo...) add variants
  url: ${GREPTIMEDB_URL}
  database: public
  auth: ${GREPTIMEDB_AUTH}
  # logsTable / tracesTable / timeoutMs are optional overrides
observability:                # optional; omit entirely to run with self-instrumentation disabled
  endpoint: ${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT}   # OTLP/HTTP traces endpoint, paperhanger's OWN spans
  # serviceName: paperhanger  # `service.name` resource attribute (default shown)
  # headers: { x-greptime-db-name: public }  # extra OTLP export headers, values may use ${ENV_VAR}
repos:
  attributeKeys: [service.repository, repository]
  mappings:
    - match: { service: my-api }
      repo: my-org/my-api
  orgSearch: { enabled: true, org: my-org }
agent:
  model: anthropic/claude-sonnet-4-6
  concurrency: 2
  timeoutMinutes: 30
  cooldownHours: 24
  maxFixAttempts: 3
  maxDiffLines: 500
  draftPr: false
  forbiddenPaths: [".github/workflows/**"]
  # hostUrl / hostPort: external agent-host or spawned-sidecar port
github:
  appId: ${GITHUB_APP_ID}
  privateKey: ${GITHUB_APP_PRIVATE_KEY}
notifiers:
  - type: slack
    webhookUrl: ${SLACK_WEBHOOK_URL}
```

### 3.10 運用

- 配布: 単一コンテナイメージ(既存 Dockerfile を拡張)。SQLite 利用時は `/data` を volume に
- エンドポイント: `/healthz`(liveness)、`/readyz`(DB 接続確認)、`GET /incidents` / `GET /incidents/:id`(状態確認用。`server.apiToken` による Bearer/X-Api-Token 認証必須、未設定時は 401)。`GET /incidents` は `?limit=` クエリパラメータで件数を指定可能(デフォルト 100、上限 500)
- ログ: 構造化 JSON。`observability` 設定時はアクティブな span の `traceId`/`spanId` をログ行に付与し相関可能にする
- トレース: `observability` 設定時、paperhanger 自身のスパンを OTLP/HTTP でエクスポート(`@opentelemetry/sdk-trace-base` + `exporter-trace-otlp-proto`。§3.9 参照)。OTel **ログ** export(paperhanger 自身のログの OTLP 送信)は引き続き将来対応
- ローカル開発: `compose.yml` で paperhanger + GreptimeDB + Grafana を起動し E2E 検証できるようにする

## 4. 技術スタック

- Bun + TypeScript(リポジトリ方針に準拠)、`Bun.serve` / `bun:sqlite` / `Bun.sql`
- Flue Framework(エージェント実行・Sandbox・Durable Execution)
  - **検証結果(2026-07-17)**: Flue の本番サーバーは `node:sqlite` 依存のため Bun では起動不可(Node >= 22.19 必須)。エージェントは `agent-host/` の **Node サイドカープロセス** として分離し、本体(Bun)から `@flue/sdk` の HTTP クライアントで駆動する。単一コンテナ配布は維持(イメージに Bun + Node を同梱し、本体が子プロセスとして起動。設定で外部 URL への接続にも切替可)。詳細は `docs/architecture.md` と `docs/research/flue.md`
  - バージョンは `1.0.0-beta.9` に固定(pre-1.0 のため破壊的変更に注意)
- lint/format: oxlint + biome(既存設定)

## 5. マイルストーン

| # | 内容 |
|---|------|
| M1 | 受信層(grafana/generic アダプタ)+ 正規化 + SQLite 永続化 + dedup |
| M2 | GreptimeDB collector + IncidentContext 生成 |
| M3 | Repo resolver + GitHub App 連携(clone/token 発行) |
| M4 | Flue エージェント: 診断 → `report_only` まで(コードは触らない) |
| M5 | 修正 → テスト → PR 作成 + ガードレール |
| M6 | Notifier(Slack/Discord/汎用)+ alertmanager アダプタ + PostgreSQL 対応 |
| M7 | compose によるモック一式 E2E テスト環境 + ドキュメント |

## 6. リスク・実装時に要検証の項目

- **Flue の正確な API・パッケージ名・ランタイム要件**(Node 前提か Bun で動くか)。実装開始時に `flue docs` / 公式ドキュメントで確認。Bun で動かない場合はコンテナ内 Node 実行に切替(スタック方針の例外として明記)
- Flue Sandbox 内の toolchain 準備方法(多言語リポジトリのビルド・テストに必要)
- GreptimeDB の OTel テーブルスキーマ(logs/traces のカラム構成)に合わせたクエリ実装
- org 動的探索の誤爆 → 確信度が低い場合の `report_only` フォールバックで緩和
- LLM コスト管理 → タイムアウト + 修正試行回数上限 + クールダウン + 同時実行上限で抑制(トークン単位の予算は Flue SDK がワークフロー単位の使用量を公開するまで未実装 — §3.6 参照)
