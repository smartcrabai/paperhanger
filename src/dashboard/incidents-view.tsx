/**
 * "Incidents" dashboard view: an auto-refreshing list (newest first, per
 * `IncidentStore.listIncidents`) alongside a detail pane for the selected
 * incident. Observation only -- no action here ever mutates an incident
 * (docs/spec.md section 3.8).
 */

import { useCallback, useEffect, useState } from "react";
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

	const refresh = useCallback(async () => {
		try {
			const result = await listIncidents(token);
			setIncidents(result);
			setError(undefined);
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				onUnauthorized();
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
			setRefreshTick((tick) => tick + 1);
		}
	}, [token, onUnauthorized]);

	useEffect(() => {
		setLoading(true);
		void refresh();
		const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [refresh]);

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
