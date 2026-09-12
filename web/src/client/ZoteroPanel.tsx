// Zotero ローカルAPI との同期パネル。
// 同期は必ず dryRun のプレビューを挟み、内容を確認してから library.json に書き込む。
import { useEffect, useState } from "react";
import { api, errorMessage } from "./api.js";
import type { LibraryState, ZoteroStatus, ZoteroSyncReport } from "./types.js";

function formatDateTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function ChangeList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="zotero-change">
      <span className="zotero-change-label">{title}</span>
      <span className="zotero-change-body">{items.join(", ")}</span>
    </div>
  );
}

function ReportView({ report }: { report: ZoteroSyncReport }) {
  const nothingToDo =
    !report.foldersCreated.length &&
    !report.foldersRenamed.length &&
    !report.foldersRemoved.length &&
    !report.moved.length;

  return (
    <div className="zotero-report">
      <div className="zotero-counts">
        <span>
          <strong>{report.collections}</strong> collections
        </span>
        <span>
          <strong>{report.items}</strong> items
        </span>
        <span>
          <strong>{report.matched.length}</strong> matched
        </span>
      </div>

      {nothingToDo ? (
        <p className="panel-note">Already up to date — nothing to change.</p>
      ) : (
        <>
          <ChangeList title="New folders" items={report.foldersCreated} />
          <ChangeList title="Renamed" items={report.foldersRenamed.map((r) => `${r.from} → ${r.to}`)} />
          <ChangeList title="Removed" items={report.foldersRemoved} />
          {report.moved.length > 0 && (
            <div className="zotero-change">
              <span className="zotero-change-label">Documents moved ({report.moved.length})</span>
              <ul className="zotero-move-list">
                {report.moved.map((move) => (
                  <li key={move.documentId}>
                    <span className="doc-id">{move.documentId}</span>
                    <span className="panel-note">
                      {move.from} → {move.to}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {report.multiCollection.length > 0 && (
        <details className="zotero-details">
          <summary>In several collections ({report.multiCollection.length})</summary>
          <ul className="zotero-move-list">
            {report.multiCollection.map((entry) => (
              <li key={entry.documentId}>
                <span className="doc-id">{entry.documentId}</span>
                <span className="panel-note">
                  filed under {entry.chosen} (also in {entry.others.join(", ")})
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.unfiledInZotero.length > 0 && (
        <p className="panel-note">
          {report.unfiledInZotero.length} matched documents are in no Zotero collection — their current folder is kept.
        </p>
      )}

      {report.unmatchedTotal > 0 && (
        <details className="zotero-details">
          <summary>Not in this app ({report.unmatchedTotal})</summary>
          <p className="panel-note">These Zotero items have no imported document yet. Import them above to search them.</p>
          <ul className="zotero-move-list">
            {report.unmatched.map((item) => (
              <li key={item.key}>
                <span>{item.title || item.key}</span>
                <span className="panel-note">{[item.year, item.doi].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
          {report.unmatchedTotal > report.unmatched.length && (
            <p className="panel-note">…and {report.unmatchedTotal - report.unmatched.length} more.</p>
          )}
        </details>
      )}
    </div>
  );
}

export function ZoteroPanel({
  library,
  onLibraryChange,
  onError,
}: {
  library: LibraryState;
  onLibraryChange: (next: LibraryState) => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<ZoteroStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<ZoteroSyncReport | null>(null);
  const [applied, setApplied] = useState<ZoteroSyncReport | null>(null);

  async function checkStatus() {
    setChecking(true);
    try {
      setStatus(await api.zoteroStatus());
    } catch (e) {
      setStatus({ available: false, base: "", error: errorMessage(e) });
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    checkStatus();
  }, []);

  async function runPreview() {
    setBusy("Reading Zotero...");
    setApplied(null);
    try {
      const { report } = await api.zoteroSync(true);
      setPreview(report);
    } catch (e) {
      onError(errorMessage(e));
      checkStatus();
    } finally {
      setBusy("");
    }
  }

  async function apply() {
    setBusy("Applying...");
    try {
      const { library: next, report } = await api.zoteroSync(false);
      onLibraryChange(next);
      setApplied(report);
      setPreview(null);
      setStatus((prev) => (prev ? { ...prev, syncedAt: report.syncedAt } : prev));
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }

  const syncedAt = status?.syncedAt ?? library.zoteroSyncedAt;

  return (
    <section className="tool-panel zotero-panel">
      <div className="panel-head">
        <h2>Zotero</h2>
        {checking ? (
          <span className="panel-note">Checking...</span>
        ) : status?.available ? (
          <span className="badge badge-ok">Connected</span>
        ) : (
          <span className="badge badge-warn">Not running</span>
        )}
      </div>

      {status?.available ? (
        <p className="panel-note zotero-meta">
          {status.collections ?? 0} collections · {status.items ?? 0} items
          {syncedAt && ` · last synced ${formatDateTime(syncedAt)}`}
        </p>
      ) : (
        !checking && <p className="warn-text zotero-meta">{status?.error}</p>
      )}

      <div className="controls compact-controls zotero-actions">
        <button className="ghost" onClick={checkStatus} disabled={checking || Boolean(busy)}>
          Re-check
        </button>
        <button className="primary" onClick={runPreview} disabled={!status?.available || Boolean(busy)}>
          {busy === "Reading Zotero..." ? "Reading..." : "Sync collections"}
        </button>
      </div>

      {busy && (
        <div className="loading inline-loading">
          <div className="spinner" />
          <span>{busy}</span>
        </div>
      )}

      {preview && (
        <>
          <div className="zotero-preview-head">
            <strong>Preview</strong>
            <span className="panel-note">Nothing has been written yet</span>
          </div>
          <ReportView report={preview} />
          <div className="controls compact-controls zotero-actions">
            <button className="ghost" onClick={() => setPreview(null)} disabled={Boolean(busy)}>
              Cancel
            </button>
            <button className="primary" onClick={apply} disabled={Boolean(busy)}>
              Apply
            </button>
          </div>
        </>
      )}

      {applied && (
        <>
          <div className="zotero-preview-head">
            <strong>Synced</strong>
            <span className="panel-note">{formatDateTime(applied.syncedAt)}</span>
          </div>
          <ReportView report={applied} />
        </>
      )}

      <p className="panel-note zotero-hint">
        Folders from Zotero follow your collections; Zotero is never written to. Documents in several collections are
        filed under the first one in the collection tree.
      </p>
    </section>
  );
}
