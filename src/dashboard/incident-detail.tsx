/**
 * Detail panel for a single incident: every stored field plus its event
 * timeline (`GET /incidents/:id/events`). `incident` comes from the already-
 * fetched list in `IncidentsView` (fetching it again would just race the
 * list's own auto-refresh); only the timeline is fetched here, re-fetching on
 * `refreshTick` so it stays current with the list's ~10s polling instead of
 * only loading once per selected incident.
 */

import { useEffect, useRef, useState } from "react";
import type { Incident } from "../core/types";
import type { IncidentEventRecord } from "../storage/types";
import { ApiError, getIncidentEvents } from "./api";
import { StatusBadge } from "./status-badge";

export function IncidentDetail({
	incidentId,
	incident,
	token,
	onUnauthorized,
	refreshTick,
}: {
	incidentId: string;
	incident: Incident | undefined;
	token: string;
	onUnauthorized: () => void;
	/** Bumped by `IncidentsView` on every list poll; triggers a background
	 *  re-fetch of the timeline below without disturbing `incidentId`. */
	refreshTick: number;
}) {
	const [events, setEvents] = useState<IncidentEventRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	// Tracks which incident the currently-shown timeline belongs to, so a
	// same-incident refresh (refreshTick change only) can swap the events in
	// place instead of flashing back to the loading placeholder.
	const shownIncidentId = useRef<string | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		if (shownIncidentId.current !== incidentId) {
			setLoading(true);
			setEvents([]);
		}
		getIncidentEvents(token, incidentId)
			.then((result) => {
				if (cancelled) {
					return;
				}
				setEvents(result);
				setError(undefined);
				shownIncidentId.current = incidentId;
			})
			.catch((err) => {
				if (cancelled) {
					return;
				}
				if (err instanceof ApiError && err.status === 401) {
					onUnauthorized();
					return;
				}
				setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [incidentId, token, onUnauthorized, refreshTick]);

	if (!incident) {
		return <p className="muted">Incident no longer in the current list.</p>;
	}

	return (
		<div className="incident-detail">
			<h2>{incident.title}</h2>
			<div className="incident-detail-header">
				<StatusBadge status={incident.status} />
				<span className="incident-severity">{incident.severity}</span>
				<span className="muted">{incident.source}</span>
			</div>
			<dl className="incident-fields">
				<dt>ID</dt>
				<dd>{incident.id}</dd>
				<dt>Fingerprint</dt>
				<dd>{incident.fingerprint}</dd>
				<dt>Created</dt>
				<dd>{new Date(incident.createdAt).toLocaleString()}</dd>
				<dt>Updated</dt>
				<dd>{new Date(incident.updatedAt).toLocaleString()}</dd>
				{incident.resolvedAt && (
					<>
						<dt>Resolved</dt>
						<dd>{new Date(incident.resolvedAt).toLocaleString()}</dd>
					</>
				)}
				{incident.prUrl && (
					<>
						<dt>Pull request</dt>
						<dd>
							<a href={incident.prUrl} target="_blank" rel="noreferrer">
								{incident.prUrl}
							</a>
						</dd>
					</>
				)}
			</dl>

			<div className="kv-block">
				<h3>Labels</h3>
				<pre>{JSON.stringify(incident.labels, null, 2)}</pre>
			</div>
			<div className="kv-block">
				<h3>Annotations</h3>
				<pre>{JSON.stringify(incident.annotations, null, 2)}</pre>
			</div>

			{incident.diagnosis && (
				<div className="kv-block">
					<h3>Diagnosis</h3>
					<pre>{incident.diagnosis}</pre>
				</div>
			)}
			{incident.failureReason && (
				<div className="kv-block">
					<h3>Failure reason</h3>
					<pre>{incident.failureReason}</pre>
				</div>
			)}

			<div className="kv-block">
				<h3>Event timeline</h3>
				{error && <p className="form-error">{error}</p>}
				{loading ? (
					<p className="muted">Loading events...</p>
				) : events.length === 0 ? (
					<p className="muted">No events recorded.</p>
				) : (
					<ol className="event-timeline">
						{events.map((record) => (
							<li key={record.id}>
								<div className="event-timeline-top">
									<span className="event-status">{record.event.status}</span>
									<span className="muted">
										{new Date(record.receivedAt).toLocaleString()}
									</span>
								</div>
								<div>{record.event.title}</div>
							</li>
						))}
					</ol>
				)}
			</div>
		</div>
	);
}
