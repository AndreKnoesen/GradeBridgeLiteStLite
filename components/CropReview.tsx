import React, { useRef, useState } from 'react';
import {
  AlertTriangle, Camera, Check, CheckCircle2, Flag, Image as ImageIcon, RefreshCw, Upload,
} from 'lucide-react';
import { CropRef, PageRef, StoredLayoutMap, StudentReview } from '../types';
import { inAssignmentOrder } from '../services/layoutMap';

/**
 * The review step, and it is the safety net.
 *
 * Every part's crop is shown before submission, in assignment order, labelled
 * as exactly what the grader will see. Not optional and not collapsible — a
 * student looking at the actual crop is a better judge of whether the capture
 * worked than any blur threshold, which is why the quality checks elsewhere
 * warn and never block.
 *
 * A flagged part does not block submission. The flag rides through to the
 * grader. There is no detector between a student and a deadline.
 */

interface CropReviewProps {
  layout: StoredLayoutMap;
  crops: Record<string, CropRef>;
  /** region_id → object URL for the stored crop bitmap. */
  cropUrls: Record<string, string>;
  pages: PageRef[];
  onReview: (regionId: string, review: StudentReview) => void;
  /** The student framed this answer themselves; the photograph IS the crop. */
  onDirectCapture: (regionId: string, file: File) => Promise<void>;
  /** Replace the whole page this part is on and re-cut every part on it. */
  onRephotographPage: (pageK: number, file: File) => Promise<void>;
  busy: string | null;
}

const REVIEW_LABEL: Record<StudentReview, string> = {
  signed_off: 'Looks right',
  flagged: 'Flagged',
  not_reviewed: 'Not checked yet',
};

const CropReview: React.FC<CropReviewProps> = ({
  layout, crops, cropUrls, pages, onReview, onDirectCapture, onRephotographPage, busy,
}) => {
  const directRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLInputElement>(null);
  const directTarget = useRef<string | null>(null);
  const pageTarget = useRef<number | null>(null);
  const [hasCamera] = useState(() =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches);

  // Assignment order: page first, then down the page. The same order the
  // student worked in, the same order the grader will read in, and — since it
  // is now the shared comparison rather than a third copy of it — the same
  // order the completeness statement lists missing answers in.
  const ordered = inAssignmentOrder(layout.rows);

  const reviewed = ordered.filter(r => crops[r.regionId]?.review === 'signed_off').length;
  const flagged = ordered.filter(r => crops[r.regionId]?.review === 'flagged').length;
  const missing = ordered.filter(r => !crops[r.regionId]).length;

  const pageFor = (k: number): PageRef | undefined =>
    pages.find(p => p.registration?.k === k);

  const handleDirect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    const target = directTarget.current;
    directTarget.current = null;
    if (target && files.length > 0) void onDirectCapture(target, files[0]);
  };

  const handlePage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    const target = pageTarget.current;
    pageTarget.current = null;
    if (target !== null && files.length > 0) void onRephotographPage(target, files[0]);
  };

  return (
    <section className="bg-white rounded-xl shadow-sm border border-gray-200 mb-8" aria-labelledby="review-heading">
      <input
        ref={directRef} type="file" accept="image/*,.heic,.heif"
        {...(hasCamera ? { capture: 'environment' as const } : {})}
        onChange={handleDirect} className="hidden"
      />
      <input
        ref={pageRef} type="file" accept="image/*,.heic,.heif"
        {...(hasCamera ? { capture: 'environment' as const } : {})}
        onChange={handlePage} className="hidden"
      />

      <div className="bg-slate-50 px-6 py-4 border-b border-gray-200">
        <h2 id="review-heading" className="text-lg font-bold text-slate-800 flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-slate-500" />
          Check every answer before you submit
        </h2>
        <p className="text-sm text-gray-600 mt-1">
          This is exactly what your grader will see — one picture per part, cut from your pages.
          If a picture is wrong, cut off or missing, fix it here.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
          <span className="px-2.5 py-1 rounded-full bg-green-100 text-green-800 border border-green-200">
            {reviewed} of {ordered.length} checked
          </span>
          {flagged > 0 && (
            <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-900 border border-amber-300">
              {flagged} flagged
            </span>
          )}
          {missing > 0 && (
            <span className="px-2.5 py-1 rounded-full bg-red-100 text-red-800 border border-red-200">
              {missing} with no picture yet
            </span>
          )}
        </div>
      </div>

      <ul className="divide-y divide-gray-200">
        {ordered.map((row) => {
          const crop = crops[row.regionId];
          const url = cropUrls[row.regionId];
          const page = pageFor(row.pageK);
          const isBusy = busy === row.regionId;

          return (
            <li key={row.regionId} className="p-5 sm:p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <h3 className="font-semibold text-gray-900">
                  {row.partId}
                  <span className="ml-2 text-xs font-normal text-gray-500">
                    page {row.pageK} · {row.maxPoints} {row.maxPoints === 1 ? 'point' : 'points'}
                    {row.isDrawing ? ' · drawing' : ''}
                  </span>
                </h3>
                {crop && (
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${
                    crop.review === 'signed_off'
                      ? 'bg-green-50 text-green-800 border-green-200'
                      : crop.review === 'flagged'
                        ? 'bg-amber-50 text-amber-900 border-amber-300'
                        : 'bg-gray-50 text-gray-600 border-gray-200'
                  }`}>
                    {REVIEW_LABEL[crop.review]}
                  </span>
                )}
              </div>

              <div className="rounded-lg border border-gray-200 bg-gray-50 overflow-hidden">
                {url ? (
                  <img
                    src={url}
                    alt={`Your answer to ${row.partId}, as your grader will see it`}
                    className="w-full h-auto max-h-[60vh] object-contain bg-white"
                  />
                ) : (
                  <div className="p-6 text-center text-sm text-gray-500">
                    {isBusy ? (
                      <span className="inline-flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 animate-spin" /> Cutting this answer out…
                      </span>
                    ) : (
                      <>
                        <AlertTriangle className="w-5 h-5 text-amber-500 mx-auto mb-2" />
                        No picture for this part yet.{' '}
                        {page
                          ? 'Its page did not line up — use one of the buttons below.'
                          : `Page ${row.pageK} has not been photographed yet.`}
                      </>
                    )}
                  </div>
                )}
              </div>

              {crop && crop.cropSource === 'direct_capture' && (
                <p className="mt-2 text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded px-3 py-2">
                  You photographed this answer yourself, so it was not cut from the printed sheet.
                  That is fine — it goes to your grader exactly as it is here.
                </p>
              )}

              {crop && crop.qualityFlags.length > 0 && (
                <ul className="mt-2 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2 space-y-1">
                  {crop.qualityFlags.map((flag) => (
                    <li key={flag} className="flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                      <span>
                        {flag === 'looks-empty'
                          ? 'This looks blank. If you wrote an answer here, check the picture above shows it.'
                          : flag}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!crop || isBusy}
                  onClick={() => onReview(row.regionId, 'signed_off')}
                  className={`min-h-[44px] px-4 rounded-lg text-sm font-medium flex items-center gap-2 border transition-colors disabled:opacity-40 ${
                    crop?.review === 'signed_off'
                      ? 'bg-green-600 border-green-600 text-white'
                      : 'bg-white border-gray-300 text-gray-800 hover:bg-gray-50'
                  }`}
                >
                  {crop?.review === 'signed_off' ? <CheckCircle2 className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                  Looks right
                </button>
                <button
                  type="button"
                  disabled={!crop || isBusy}
                  onClick={() => onReview(row.regionId, 'flagged')}
                  className={`min-h-[44px] px-4 rounded-lg text-sm font-medium flex items-center gap-2 border transition-colors disabled:opacity-40 ${
                    crop?.review === 'flagged'
                      ? 'bg-amber-500 border-amber-500 text-white'
                      : 'bg-white border-gray-300 text-gray-800 hover:bg-gray-50'
                  }`}
                >
                  <Flag className="w-4 h-4" />
                  Something is wrong
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => { directTarget.current = row.regionId; directRef.current?.click(); }}
                  className="min-h-[44px] px-4 rounded-lg text-sm font-medium flex items-center gap-2 border border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 disabled:opacity-40"
                >
                  {hasCamera ? <Camera className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                  Photograph just this answer
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => { pageTarget.current = row.pageK; pageRef.current?.click(); }}
                  className="min-h-[44px] px-4 rounded-lg text-sm font-medium flex items-center gap-2 border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  <RefreshCw className="w-4 h-4" />
                  Retake page {row.pageK}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="px-6 py-4 border-t border-gray-200 bg-slate-50 text-xs text-gray-600">
        Flagging a part does <strong>not</strong> stop you submitting. The flag goes to your grader
        with the picture, so they know you were not happy with it.
      </div>
    </section>
  );
};

export default CropReview;
