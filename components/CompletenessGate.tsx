import React, { useEffect, useRef } from 'react';
import { AlertTriangle, ArrowLeft, Download } from 'lucide-react';
import { CompletenessNotice } from '../services/completeness';

/**
 * The gate that stands between an incomplete submission and its download.
 *
 * ## Why this is in the page and not a `window.confirm`
 *
 * It was a `confirm` until 2026-09-09. Browsers suppress repeated JavaScript
 * dialogs, and a suppressed `confirm()` **does not show a dialog, does not
 * wait, and returns `false`** — the HTML Standard says so normatively ("If we
 * cannot show simple dialogs for this, then return false"), MDN says "if a
 * browser is ignoring in-page dialogs, then the returned value is always
 * false", and WebKit's `confirmForBindings` returns false on every path that
 * declines to show one. The handler read that `false` as "the student
 * cancelled", so a student whose browser had begun ignoring dialogs could tap
 * Download and get **nothing at all**, permanently, with the only on-screen
 * text telling them to try again.
 *
 * That is not hypothetical for this app: `App.tsx` fires a confirm on every
 * page removal, and two back-to-back on the clear-work path. Nor does it need
 * the user to tick anything — Chrome suppresses `confirm()` outright in a
 * background tab, and a phone student who switches away while the package
 * builds is in a background tab.
 *
 * **The standing rule this now obeys is in `CLAUDE.md`: a guard on a
 * constructive action must fail open.** Downloading is constructive; a guard
 * over it that fails closed turns partial credit into a zero.
 *
 * ## Three things the gate buys beyond not being suppressible
 *
 *   - **Nothing is default-activated.** In a `confirm`, OK is the default
 *     button and Enter downloads an incomplete submission. Here the heading
 *     takes focus and neither control is one keystroke away.
 *   - **No cap on the list.** The dialog named six answers and said "and 8
 *     more"; a panel scrolls, so all seventeen are simply there.
 *   - **It works in an in-app WebView**, where dialog behaviour is its own
 *     unknown — see `services/inAppBrowser.ts`.
 *
 * ## It is a gate, not a banner, and that is deliberate
 *
 * A notice *beside* the Download button can be scrolled past. **Download
 * anyway lives inside this panel**, so the panel cannot be bypassed to reach
 * it. That is the whole reason the in-page route is safe where a banner would
 * not be.
 *
 * ## Continuing is a plain path, not a dark pattern
 *
 * A student handing in partial work on purpose is a real and legitimate case.
 * "Download anyway" is a full-size, plainly labelled button of the same weight
 * as the other, not a link hidden under the fold. What it is not is the
 * default: they have to mean it.
 */

interface CompletenessGateProps {
  notice: CompletenessNotice;
  /** Rebuilds the package and downloads it, shortfall and all. */
  onDownloadAnyway: () => void;
  /** Dismisses the gate. Nothing is downloaded and nothing is discarded. */
  onGoBack: () => void;
}

const CompletenessGate: React.FC<CompletenessGateProps> = ({
  notice, onDownloadAnyway, onGoBack,
}) => {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Focus the heading rather than either button: a screen reader announces what
  // this is, and no keystroke can answer it by accident. This is the half of
  // the fix that `window.confirm` could not provide at all.
  useEffect(() => { headingRef.current?.focus(); }, []);

  // Escape returns to the work. It never downloads — the destructive-by-mistake
  // direction here is submitting something the student had not decided to send.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onGoBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onGoBack]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/75 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="completeness-gate-heading"
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">

        <div className="px-6 pt-6 pb-4 border-b border-gray-200">
          <h2
            ref={headingRef}
            tabIndex={-1}
            id="completeness-gate-heading"
            className="text-lg font-bold text-slate-900 flex items-center gap-2 outline-none"
          >
            <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0" />
            Some answers are not in your submission
          </h2>
          <p className="mt-2 text-sm text-gray-700">{notice.headline}</p>
        </div>

        {notice.itemised && (
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">
              Missing
            </p>
            <ul className="space-y-3">
              {notice.groups.map((group) => (
                <li key={group.pageK}>
                  <p className="text-sm font-semibold text-slate-800">Page {group.pageK}</p>
                  <p className="text-sm text-gray-700">{group.names.join(', ')}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="px-6 py-4 border-t border-gray-200 bg-slate-50 rounded-b-2xl">
          <p className="text-sm text-gray-700 mb-4">{notice.choice}</p>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={onGoBack}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium text-sm transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Go back and add them
            </button>
            <button
              type="button"
              onClick={onDownloadAnyway}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 rounded-lg font-medium text-sm transition-colors"
            >
              <Download className="w-4 h-4" />
              Download anyway
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

export default CompletenessGate;
