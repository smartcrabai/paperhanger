/**
 * "Incidents" dashboard view: an auto-refreshing list (newest first, per
 * `IncidentStore.listIncidents`) alongside a detail pane for the selected
 * incident. Observation only -- no action here ever mutates an incident
 * (docs/spec.md section 3.8).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Incident } from "../core/types";
import { ApiError, listIncidents } from "./api";
import { IncidentDetail } from "./incident-detail";
import { StatusBadge } from "./status-badge";

/** How often the list re-fetches while this view is mounted (design doc: "~10s"). */
const REFRESH_INTERVAL_MS = 10_000;

export function IncidentsView({
	token,
	onUnauthorized,
}: {
	token: string;
	onUnauthorized: () => void;
}) {
	const [incidents, setIncidents] = useState<Incident[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [selectedId, setSelectedId] = useState<string | undefined>();
	// Bumped on every poll (success or failure) so `IncidentDetail` re-fetches
	// its event timeline on the same cadence as this list, instead of once
	// per selected incident (see the design doc's incident-detail refresh fix).
	const [refreshTick, setRefreshTick] = useState(0);
	// The `refresh` instance a 401 already reported. Without this the poll
	// re-invokes `onUnauthorized` (and keeps polling) on every ~10s tick for
	// as long as the token stays bad. Keyed on `refresh`'s identity -- not the
	// token string -- because App keeps this view mounted through
	// re-authentication (see app.tsx's reauth overlay) and bumps an auth
	// epoch on every submit, including a resubmit of the SAME token: `refresh`
	// depends on `onUnauthorized`, whose identity changes with the epoch, so
	// a same-token resubmit still gets a fresh `refresh` and is free to poll
	// again. Comparing the old `rejectedToken === token` string instead left
	// a same-token resubmit permanently stuck (no prop the poll effect
	// watched ever changed), freezing the view.
	const rejectedRefreshRef = useRef<(() => Promise<void>) | undefined>(
		undefined,
	);
	const [rejectedRefresh, setRejectedRefresh] = useState<
		(() => Promise<void>) | undefined
	>(undefined);
	// Tags each `refresh` call so a response can tell whether it is still the
	// newest in flight -- otherwise a poll that resolves out of order (e.g.
	// N+1 finishing before N) would let the stale poll N response overwrite
	// the fresher list.
	const generationRef = useRef(0);

	const refresh = useCallback(async () => {
		const generation = ++generationRef.current;
		try {
			const result = await listIncidents(token);
			if (generation !== generationRef.current) return;
			setIncidents(result);
			setError(undefined);
		} catch (err) {
			// A superseded response changes nothing at all, not even the auth
			// state: the newest request is the one that decides.
			if (generation !== generationRef.current) return;
			if (err instanceof ApiError && err.status === 401) {
				if (rejectedRefreshRef.current === refresh) return;
				rejectedRefreshRef.current = refresh;
				// Wrapped in a thunk: `useState`'s setter treats a bare function
				// argument as an updater, not a value to store.
				setRejectedRefresh(() => refresh);
				onUnauthorized();
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (generation === generationRef.current) {
				setLoading(false);
				setRefreshTick((tick) => tick + 1);
			}
		}
	}, [token, onUnauthorized]);

	useEffect(() => {
		if (rejectedRefresh === refresh) return;
		setLoading(true);
		void refresh();
		const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [refresh, rejectedRefresh]);

	const selected = incidents.find((incident) => incident.id === selectedId);

	return (
		<section className="incidents-view">
			<div className="incidents-list">
				<div className="view-header">
					<h2>Incidents</h2>
				</div>
				{error && <p className="form-error">{error}</p>}
				{loading ? (
					<p className="muted">Loading...</p>
				) : incidents.length === 0 ? (
					<p className="muted">No incidents yet.</p>
				) : (
					<ul className="incident-rows">
						{incidents.map((incident) => (
							<li key={incident.id}>
								<button
									type="button"
									className={
										incident.id === selectedId
											? "incident-row selected"
											: "incident-row"
									}
									onClick={() => setSelectedId(incident.id)}
								>
									<div className="incident-row-top">
										<StatusBadge status={incident.status} />
										<span className="incident-severity">
											{incident.severity}
										</span>
									</div>
									<div className="incident-title">{incident.title}</div>
									<div className="incident-meta">
										<span>{incident.source}</span>
										<span>{new Date(incident.createdAt).toLocaleString()}</span>
										{incident.prUrl && <span className="pr-flag">PR</span>}
									</div>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
			<div className="incident-detail-pane">
				{selectedId ? (
					<IncidentDetail
						incidentId={selectedId}
						incident={selected}
						token={token}
						onUnauthorized={onUnauthorized}
						refreshTick={refreshTick}
					/>
				) : (
					<p className="muted">Select an incident to see its details.</p>
				)}
			</div>
		</section>
	);
}
