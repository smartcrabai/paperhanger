/**
 * Source adapter contract. Each configured webhook source (grafana, generic,
 * ...) has one adapter that normalizes its payload into `IncidentEvent[]`.
 * See docs/spec.md section 3.1.
 */

import type { IncidentEvent } from "../../core/types";

export interface SourceAdapter {
	readonly name: string;
	/**
	 * Parses the incoming webhook request body into zero or more normalized
	 * events (a single webhook call may carry multiple alerts). Throws a
	 * descriptive `Error` if the payload cannot be parsed or fails validation;
	 * callers should turn that into an HTTP 400.
	 */
	parse(req: Request): Promise<IncidentEvent[]>;
}
