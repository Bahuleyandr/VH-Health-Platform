"use client";

import type { WithheldKey } from "@/lib/api/encryptionKeys";
import { EyeOff } from "lucide-react";

/**
 * The disclosure half of the list response.
 *
 * `GET /admin/encryption-keys` partitions what the tenant can see: rows this
 * console can act on in `keys`, and EVERY other visible row in `protected`,
 * each carrying the class it landed in and the marker that put it there. The
 * client used to type the response as `{ keys, count }` and throw the rest
 * away, which turned "nothing is dropped" into a promise no operator could
 * check. This panel is where it is kept.
 *
 * Rendered even when nothing was withheld, so "withheld rows appear here" is
 * answerable either way rather than silently absent.
 */
export function WithheldKeysPanel({
  rows,
  count,
  listedCount,
  statusFilterActive,
}: {
  rows: WithheldKey[];
  /** The server's `protected_count`. */
  count: number;
  /** The server's `count` — the actionable rows shown in the table above. */
  listedCount: number;
  statusFilterActive: boolean;
}) {
  const scope = statusFilterActive
    ? "every row this tenant can see with the selected status"
    : "every row this tenant can see";

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
        <EyeOff className="h-4 w-4" />
        <h2>Withheld from this console</h2>
        <span className="font-normal text-muted-foreground">({count})</span>
      </div>

      <div className="px-4 py-3 text-sm text-muted-foreground">
        {count === 0 ? (
          <p>
            The backend withheld no row from this listing.{" "}
            {listedCount > 0
              ? `The ${listedCount} ${listedCount === 1 ? "entry" : "entries"} above ${listedCount === 1 ? "is" : "are"} ${scope}.`
              : "There is nothing above either."}
          </p>
        ) : (
          <p>
            These rows exist and this tenant can see them, but this console does
            not manage them. They are named here rather than left silently
            missing: together with the {listedCount}{" "}
            {listedCount === 1 ? "entry" : "entries"} above they are {scope}.
            Retire and mark-compromised refuse a row listed here rather than
            acting on it, and a rotation will not demote one.
          </p>
        )}
      </div>

      {count > 0 && (
        <div className="overflow-x-auto border-t border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Key id</th>
                <th className="px-3 py-2 text-left">Provider</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Withheld as</th>
                <th className="px-3 py-2 text-left">Why</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-3 py-3 align-top">
                    <span className="font-mono text-xs text-foreground">
                      {row.key_id}
                    </span>
                  </td>
                  <td className="px-3 py-3 align-top font-mono text-xs">
                    {row.provider}
                  </td>
                  <td className="px-3 py-3 align-top font-mono text-xs">
                    {row.status}
                  </td>
                  <td className="px-3 py-3 align-top text-xs">
                    <span className="inline-flex whitespace-nowrap rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-medium text-slate-700">
                      {withheldClassLabel(row.key_class)}
                    </span>
                  </td>
                  <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                    {row.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * A readable name for each `key_class` the backend can send. The parameter is
 * widened to `string` so an unrecognised class renders as itself rather than
 * disappearing — the point of this panel is that no row goes unnamed.
 */
function withheldClassLabel(value: string): string {
  switch (value) {
    case "live_key_material":
      return "Live key material";
    case "signing_key":
      return "Signing key";
    case "unproven":
      return "Not provably inert";
    case "out_of_tenant_scope":
      return "Not scoped to this tenant";
    default:
      return value;
  }
}
