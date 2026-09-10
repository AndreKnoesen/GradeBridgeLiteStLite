import React, { useState, useEffect, useCallback, useRef } from 'react';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import Sidebar from './components/Sidebar';
import ProblemRenderer from './components/ProblemRenderer';
import PageUploader from './components/PageUploader';
import CropReview from './components/CropReview';
import PrintView from './components/PrintView';
import { PrivacyNotice } from './components/PrivacyNotice';
import {
  AppState, Assignment, CropRef, PageRef, StoredLayoutMap, StudentReview,
  SubmissionData, BackupData,
} from './types';
import { STORAGE_KEY, PRIVACY_KEY, VERSION } from './constants';
import { IngestedPage, blobToDataUri, dataUriToBlob, ingestPage, rotatePageBlob } from './imageIngest';
import { downloadBlob } from './downloadFile';
import { clearPageBlobs, deletePageBlob, getPageBlob, putPageBlob, pruneExcept } from './pageStore';
import { DEMO_ASSIGNMENT, DEMO_LOADED_MESSAGE } from './demoAssignment';
import { AlertTriangle, Download, ChevronLeft, Info, X, Monitor, Smartphone, Save } from 'lucide-react';
import { isEncoded, decryptJson, GB2_KEY_ERROR } from './cryptoService';
import { BundleError, chooseLayoutSource, loadAssignmentBundle } from './services/assignmentBundle';
import { completenessMessage, submissionCompleteness } from './services/completeness';
import { LayoutMapError, parseLayoutCsv } from './services/layoutMap';
import { registerAndCropPage } from './services/pageCrops';
import { initQrReader } from './services/qrDecode';
import {
  SUBMISSION_ZIP_OPTIONS, buildSubmissionPackage, cropBlobKey, cropList, submissionBaseName,
} from './services/submissionPackage';

function downsampleImage(dataUri: string, maxPx = 1920, quality = 0.82): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxPx || height > maxPx) {
        const scale = maxPx / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataUri;
  });
}

// Page order drives the filenames the pages are written under in the submission
// ZIP, so it is recomputed on every add, removal and reorder. Crops bind to
// PageRef.id and to the page's own `k` from its QR, never to the filename, so
// reordering never invalidates one.
//
// (This comment used to assert the pages ship. Until the fix below they did
// not: the ZIP builder never referenced state.pages, so a handwritten student
// submitted the blank question paper and a JSON of nulls. They ship now.)
const renumberPages = (pages: PageRef[]): PageRef[] =>
  pages.map((page, idx) => ({ ...page, file: `page_${idx + 1}.jpg` }));

const newPageId = (): string =>
  `pg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * IndexedDB key for a crop bitmap; page bitmaps use the bare PageRef.id.
 *
 * Both this and `cropList` now come from `services/submissionPackage`, because
 * the package is written from the same keys and the same order and the two must
 * not be able to drift. Re-exported here under the names the component already
 * used so the call sites read as they did.
 */
const cropKey = cropBlobKey;

const cropFileName = (regionId: string): string =>
  `crops/${regionId.replace(/[^a-z0-9_\-]/gi, '_')}.jpg`;

const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    assignment: null,
    submissionData: {},
    pages: [],
    layout: null,
    crops: {},
    viewMode: 'edit',
    lastSaved: null,
    privacyAcknowledged: false
  });
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [showMobileBanner, setShowMobileBanner] = useState(false);
  const [pdfProgress, setPdfProgress] = useState<{ active: boolean; phase: 'pdf' | 'packaging'; current: number; total: number }>({ active: false, phase: 'pdf', current: 0, total: 0 });

  // Object URLs for the stored page bitmaps. A page with no entry here has
  // metadata but no image — the uploader surfaces it as needing re-upload.
  const [pageUrls, setPageUrls] = useState<Record<string, string>>({});
  const pageUrlsRef = useRef<Record<string, string>>({});

  // The same, for crop bitmaps, keyed by region_id.
  const [cropUrls, setCropUrls] = useState<Record<string, string>>({});
  const cropUrlsRef = useRef<Record<string, string>>({});

  /** region_id currently being re-cut, so the review row can say so. */
  const [cropBusy, setCropBusy] = useState<string | null>(null);

  const isHandwritten = state.assignment?.inputMode === 'handwritten';

  const setPageUrl = useCallback((id: string, blob: Blob) => {
    const previous = pageUrlsRef.current[id];
    if (previous) URL.revokeObjectURL(previous);
    pageUrlsRef.current = { ...pageUrlsRef.current, [id]: URL.createObjectURL(blob) };
    setPageUrls(pageUrlsRef.current);
  }, []);

  const dropPageUrl = useCallback((id: string) => {
    const previous = pageUrlsRef.current[id];
    if (!previous) return;
    URL.revokeObjectURL(previous);
    const { [id]: _removed, ...rest } = pageUrlsRef.current;
    pageUrlsRef.current = rest;
    setPageUrls(rest);
  }, []);

  const dropAllPageUrls = useCallback(() => {
    Object.values(pageUrlsRef.current).forEach(URL.revokeObjectURL);
    pageUrlsRef.current = {};
    setPageUrls({});
  }, []);

  const setCropUrl = useCallback((regionId: string, blob: Blob) => {
    const previous = cropUrlsRef.current[regionId];
    if (previous) URL.revokeObjectURL(previous);
    cropUrlsRef.current = { ...cropUrlsRef.current, [regionId]: URL.createObjectURL(blob) };
    setCropUrls(cropUrlsRef.current);
  }, []);

  const dropAllCropUrls = useCallback(() => {
    Object.values(cropUrlsRef.current).forEach(URL.revokeObjectURL);
    cropUrlsRef.current = {};
    setCropUrls({});
  }, []);

  // Revoke on unmount so a long session does not leak page or crop bitmaps.
  useEffect(() => () => {
    Object.values(pageUrlsRef.current).forEach(URL.revokeObjectURL);
    Object.values(cropUrlsRef.current).forEach(URL.revokeObjectURL);
  }, []);

  /**
   * Pulls stored bitmaps for the pages and crops; anything missing stays
   * missing. The prune has to see BOTH lists — page and crop bitmaps share one
   * object store, so pruning against the pages alone deletes every crop.
   */
  const hydrateStoredImages = useCallback(async (
    pages: PageRef[], crops: Record<string, CropRef>
  ) => {
    for (const page of pages) {
      const blob = await getPageBlob(page.id);
      if (blob) setPageUrl(page.id, blob);
    }
    for (const regionId of Object.keys(crops)) {
      const blob = await getPageBlob(cropKey(regionId));
      if (blob) setCropUrl(regionId, blob);
    }
    await pruneExcept([
      ...pages.map((p) => p.id),
      ...Object.keys(crops).map(cropKey),
    ]);
  }, [setPageUrl, setCropUrl]);

  // Build the QR decoder as soon as the app mounts.
  //
  // Nothing is fetched — the wasm is bytes already in this bundle — so this
  // cannot fail on a bad connection and there is no window in which the app is
  // up and the decoder is not. It is started here only so the compile is paid
  // while the student is still reading the page rather than after their first
  // photograph. `registerAndCropPage` awaits it regardless, so a mount that
  // never runs this costs a few tens of milliseconds and nothing else; the
  // rejection is swallowed for the same reason.
  useEffect(() => {
    initQrReader().catch(() => {});
  }, []);

  // Mobile detection
  useEffect(() => {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.innerWidth < 768;
    if (isMobile) {
      setShowMobileBanner(true);
    }
  }, []);

  // Initial Load
  useEffect(() => {
    // Privacy Check
    const privacy = localStorage.getItem(PRIVACY_KEY);
    if (privacy !== 'true') {
      setShowPrivacyModal(true);
    } else {
      setState(s => ({ ...s, privacyAcknowledged: true }));
    }

    // Data Restore
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Only restore if version matches or simple check passes
        if (parsed.submissionData) {
           const pages: PageRef[] = Array.isArray(parsed.pages) ? parsed.pages : [];
           const crops: Record<string, CropRef> =
             parsed.crops && typeof parsed.crops === 'object' ? parsed.crops : {};
           setState(prev => ({
             ...prev,
             assignment: parsed.assignment || null,
             submissionData: parsed.submissionData || {},
             pages,
             layout: parsed.layout ?? null,
             crops,
             lastSaved: parsed.lastSaved || null,
             privacyAcknowledged: true // If they have data, they likely ack'd privacy
           }));
           // Page and crop bitmaps live in IndexedDB, so they restore separately
           // and may be gone (cleared cache, different browser). The metadata is
           // kept either way — re-photographing the page re-cuts its crops.
           if (pages.length > 0 || Object.keys(crops).length > 0) {
             void hydrateStoredImages(pages, crops);
           }
        }
      } catch (e) {
        console.error("Failed to restore session", e);
      }
    }
  }, []);

  // Auto Save Debounced
  // Only the small data goes here. Page bitmaps are written to IndexedDB as
  // they are ingested; localStorage keeps their metadata, which is a few
  // hundred bytes a page instead of a few hundred kilobytes.
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (Object.keys(state.submissionData).length > 0 || state.pages.length > 0) {
        const toSave = {
          assignment: state.assignment,
          submissionData: state.submissionData,
          pages: state.pages,
          layout: state.layout,
          crops: state.crops,
          lastSaved: new Date().toISOString()
        };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
          setState(s => ({ ...s, lastSaved: toSave.lastSaved }));
        } catch (err) {
          // A silent autosave failure is how drafts disappear. Say so, and
          // point at the backup file, which does not use this quota.
          console.error('Autosave failed', err);
          setStatusMessage('Auto-save failed — this browser is out of storage. Use "Save Backup" to keep your work.');
        }
      }
    }, 1000);

    return () => clearTimeout(timeoutId);
  }, [state.submissionData, state.assignment, state.pages, state.layout, state.crops]);

  // Handlers
  const handleSubmissionChange = (id: string, data: SubmissionData['key']) => {
    setState(prev => ({
      ...prev,
      submissionData: {
        ...prev.submissionData,
        [id]: data
      }
    }));
  };

  // --- Handwritten page pool ---

  /**
   * Registers one photographed page and stores every crop the map declares for
   * it. Runs on upload, on replace and on rotate, because all three change what
   * the camera actually delivered and none of them can be corrected for by
   * moving a rectangle: the transform is fitted to the marks on THIS bitmap.
   *
   * A page whose QR names a layout other than the one in the loaded file is
   * refused here and nothing is cropped. That is the single check standing
   * between a student who printed this week's sheet and loaded last week's zip
   * and a submission full of perfectly cut rectangles under the wrong labels.
   */
  const runRegistration = useCallback(async (
    pageId: string, blob: Blob, layout: StoredLayoutMap | null, pageWarnings: string[]
  ): Promise<void> => {
    const result = await registerAndCropPage(blob, layout);
    const reg = result.registration;
    const fields = reg.qr?.fields;

    const info: PageRef['registration'] = result.layoutMismatch
      ? {
          status: 'layout_mismatch',
          k: fields?.k, n: fields?.n, layoutId: result.layoutMismatch.onPage,
          marksFound: reg.marksFound, marksDetected: reg.marksDetected,
          marksDeclined: reg.marksDeclined,
          message:
            'This page belongs to a different version of the assignment than the file you loaded, ' +
            'so nothing was cut from it. Load the assignment zip you printed these pages from.',
        }
      : !reg.usable
        ? {
            status: 'failed',
            k: fields?.k, n: fields?.n, layoutId: fields?.layoutId,
            marksFound: reg.marksFound, marksDetected: reg.marksDetected,
            marksDeclined: reg.marksDeclined, message: reg.message,
          }
        : {
            status: reg.status === 'degraded' ? 'degraded' : 'ok',
            k: fields?.k, n: fields?.n, layoutId: fields?.layoutId,
            marksFound: reg.marksFound,
            marksDetected: reg.marksDetected,
            marksDeclined: reg.marksDeclined,
            residualMm: reg.residualMm ?? undefined,
            heldOutMm: reg.heldOutMm ?? undefined,
            message: reg.message,
          };

    const cut: Record<string, CropRef> = {};
    for (const c of result.crops) {
      await putPageBlob(cropKey(c.row.regionId), c.blob);
      setCropUrl(c.row.regionId, c.blob);
      cut[c.row.regionId] = {
        regionId: c.row.regionId,
        partId: c.row.partId,
        pageK: c.row.pageK,
        isDrawing: c.row.isDrawing,
        maxPoints: c.row.maxPoints,
        cropSource: 'registration',
        // Re-cutting a page resets its sign-off: the picture the student
        // approved is not the picture that would now be submitted.
        review: 'not_reviewed',
        qualityFlags: [...c.flags, ...pageWarnings],
        file: cropFileName(c.row.regionId),
        width: c.width,
        height: c.height,
        bytes: c.blob.size,
        fromPage: pageId,
      };
    }

    setState(prev => ({
      ...prev,
      pages: prev.pages.map(page => page.id === pageId ? { ...page, registration: info } : page),
      crops: { ...prev.crops, ...cut },
    }));
  }, [setCropUrl]);

  const handleAddPage = async (ingested: IngestedPage) => {
    const id = newPageId();
    await putPageBlob(id, ingested.blob);
    setPageUrl(id, ingested.blob);
    setState(prev => ({
      ...prev,
      pages: renumberPages([
        ...prev.pages,
        {
          id,
          file: '',
          width: ingested.width,
          height: ingested.height,
          bytes: ingested.bytes,
          sourceName: ingested.sourceName,
          warnings: ingested.warnings,
          registration: { status: 'pending' }
        }
      ])
    }));
    if (isHandwritten) await runRegistration(id, ingested.blob, state.layout, ingested.warnings);
  };

  // Keeps the id, so the page keeps its place in the pool and its crops are
  // re-cut into the same region slots.
  const handleReplacePage = async (id: string, ingested: IngestedPage) => {
    await putPageBlob(id, ingested.blob);
    setPageUrl(id, ingested.blob);
    setState(prev => ({
      ...prev,
      pages: prev.pages.map(page => page.id === id
        ? {
            ...page,
            width: ingested.width,
            height: ingested.height,
            bytes: ingested.bytes,
            sourceName: ingested.sourceName,
            warnings: ingested.warnings,
            registration: { status: 'pending' }
          }
        : page)
    }));
    if (isHandwritten) await runRegistration(id, ingested.blob, state.layout, ingested.warnings);
  };

  // Rotation rewrites the stored bitmap, so width/height swap with it and the
  // autosave picks the new metadata up on the next tick. The blob itself is
  // already in IndexedDB by the time this returns.
  const handleRotatePage = async (id: string) => {
    const blob = await getPageBlob(id);
    if (!blob) {
      setStatusMessage('That page image is no longer stored in this browser — upload it again to rotate it.');
      return;
    }
    try {
      const rotated = await rotatePageBlob(blob);
      await putPageBlob(id, rotated.blob);
      setPageUrl(id, rotated.blob);
      const warnings = state.pages.find(p => p.id === id)?.warnings ?? [];
      setState(prev => ({
        ...prev,
        pages: prev.pages.map(page => page.id === id
          ? {
              ...page, width: rotated.width, height: rotated.height, bytes: rotated.bytes,
              registration: { status: 'pending' }
            }
          : page)
      }));
      // Rotation rewrites the stored bitmap, so the transform fitted to the old
      // one is void. Re-register rather than trying to turn the map: the marks
      // are on the paper and the paper just moved.
      if (isHandwritten) await runRegistration(id, rotated.blob, state.layout, warnings);
    } catch (err) {
      console.error('Rotate failed', err);
      setStatusMessage('This page could not be rotated. Try retaking it.');
    }
  };

  const handleRemovePage = (id: string) => {
    if (!window.confirm("Remove this page? You can upload it again afterwards, but the answers cut from it will go with it.")) {
      return;
    }
    void deletePageBlob(id);
    dropPageUrl(id);
    setState(prev => {
      // Crops the student photographed directly are theirs, not this page's,
      // and survive the page going away.
      const crops: Record<string, CropRef> = {};
      for (const crop of cropList(prev.crops)) {
        if (crop.fromPage === id && crop.cropSource === 'registration') {
          void deletePageBlob(cropKey(crop.regionId));
          continue;
        }
        crops[crop.regionId] = crop;
      }
      return { ...prev, crops, pages: renumberPages(prev.pages.filter(page => page.id !== id)) };
    });
  };

  const handleMovePage = (id: string, delta: number) => {
    setState(prev => {
      const from = prev.pages.findIndex(page => page.id === id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= prev.pages.length) return prev;
      const pages = [...prev.pages];
      const [moved] = pages.splice(from, 1);
      pages.splice(to, 0, moved);
      return { ...prev, pages: renumberPages(pages) };
    });
  };

  // --- Review and the two recovery routes (work order section 5) ---

  const handleReviewCrop = (regionId: string, review: StudentReview) => {
    setState(prev => {
      const crop = prev.crops[regionId];
      if (!crop) return prev;
      return { ...prev, crops: { ...prev.crops, [regionId]: { ...crop, review } } };
    });
  };

  /**
   * Recovery route two: the student frames just that answer and the photograph
   * **is** the crop. No registration, no rectangle, no map lookup for geometry —
   * only the map row's labels, which are what the grader needs to file it.
   *
   * This is also the route for a student with no printer, who writes on blank
   * paper and photographs each answer in turn. `crop_source` says so, because a
   * grader must not assume a direct capture came from a known rectangle on a
   * registered page.
   */
  const handleDirectCapture = async (regionId: string, file: File) => {
    const row = state.layout?.rows.find(r => r.regionId === regionId);
    if (!row) return;
    setCropBusy(regionId);
    try {
      const result = await ingestPage(file);
      if (!result.page) {
        setStatusMessage(result.reason ?? 'That photo could not be used. Try taking it again.');
        return;
      }
      await putPageBlob(cropKey(regionId), result.page.blob);
      setCropUrl(regionId, result.page.blob);
      setState(prev => ({
        ...prev,
        crops: {
          ...prev.crops,
          [regionId]: {
            regionId,
            partId: row.partId,
            pageK: row.pageK,
            isDrawing: row.isDrawing,
            maxPoints: row.maxPoints,
            cropSource: 'direct_capture',
            review: 'not_reviewed',
            qualityFlags: result.page.warnings,
            file: cropFileName(regionId),
            width: result.page.width,
            height: result.page.height,
            bytes: result.page.bytes,
          },
        },
      }));
      setStatusMessage('');
    } finally {
      setCropBusy(null);
    }
  };

  /**
   * Recovery route one: replace the whole page and re-cut every part on it.
   * A page the student has not photographed yet is added rather than replaced,
   * so "retake page 4" works before page 4 exists.
   */
  const handleRephotographPage = async (pageK: number, file: File) => {
    setCropBusy(`page-${pageK}`);
    try {
      const result = await ingestPage(file);
      if (!result.page) {
        setStatusMessage(result.reason ?? 'That photo could not be used. Try taking it again.');
        return;
      }
      const existing = state.pages.find(p => p.registration?.k === pageK);
      if (existing) await handleReplacePage(existing.id, result.page);
      else await handleAddPage(result.page);
      setStatusMessage('');
    } finally {
      setCropBusy(null);
    }
  };

  /**
   * The student loads ONE file: the `student/` folder of the instructor's
   * export, zipped — the same file they printed the PDF from. The zip carries
   * the spec and the geometry map together, which is what makes the stale-map
   * check possible at all.
   *
   * A bare `assignment_spec.json` still loads. Electronic assignments have no
   * map and never needed one, and every file already in circulation is a bare
   * spec, so refusing one would break them all to buy nothing.
   *
   * Since 2026-09-06 a bare spec can also BE the whole handwritten assignment:
   * the map travels inside it, gb1-encoded with everything else, so there is
   * no second file to open, choose wrongly, read, or edit. A separate
   * `layout_*.csv` still wins wherever one is present.
   */
  const handleLoadAssignment = async (file: File) => {
      try {
        const loaded = await loadAssignmentBundle(file);
        const raw = loaded.specText;
        // Decode if encoded by Assignment Maker (gb1:…), otherwise parse plain JSON
        const decoded = (isEncoded(raw)
          ? await decryptJson(raw)
          : JSON.parse(raw)) as unknown;

        // Path-3 wrong-app detection: if this looks like an MQ assignment
        // (has questionPool[]), redirect the student to the MQ app instead
        // of failing with a confusing parse error.
        const obj = decoded as { questionPool?: unknown; problems?: unknown };
        if (Array.isArray(obj?.questionPool) && !Array.isArray(obj?.problems)) {
          if (window.confirm(
            "Wrong app for this file.\n\n" +
            "The file you loaded is an MQ (multiple-choice quiz) assignment, " +
            "not a lab/homework assignment. This app handles lab and homework " +
            "submissions.\n\n" +
            "Click OK to open the MQ Student Submission app in a new tab.\n" +
            "Click Cancel to stay here and try a different file."
          )) {
            window.open(
              'https://bridgesuite.github.io/GradeBridge-MQ-Student-Submission/',
              '_blank',
              'noopener'
            );
          }
          return;
        }

        const json = decoded as Assignment;
        // Basic validation
        if (!json.problems || !json.title || !json.courseCode) {
          throw new Error("Invalid assignment file format");
        }
        // The map: beside the spec if the bundle carried one, otherwise inside
        // it. A separate `layout_*.csv` wins, so every packet already in
        // circulation loads exactly as it does today.
        const source = chooseLayoutSource(loaded.layout, json);
        let layout: StoredLayoutMap | null = null;
        if (source) {
          layout = await parseLayoutCsv(source.text, source.name);
          if (layout.declaredLayoutId && layout.declaredLayoutId !== layout.computedLayoutId) {
            throw new LayoutMapError(
              `${source.name} says its layout id is ${layout.declaredLayoutId}, but its own ` +
              `rows come to ${layout.computedLayoutId}. The file has been edited or was not ` +
              "downloaded completely — get the assignment file again."
            );
          }
        }

        // A handwritten assignment with no map from either place can be
        // photographed but never cropped. **Refuse it**, before anything is
        // dropped and before any state moves. This used to warn and load
        // anyway, which left the student in the broken state it described and
        // let them photograph sixteen pages before finding out.
        if (json.inputMode === 'handwritten' && !layout) {
          alert(
            "This assignment is written on paper, but the file you loaded has no layout map in it.\n\n" +
            "You can still photograph your pages, but the app cannot cut your answers out of them " +
            "for you, and your grader will get whole pages instead of answers.\n\n" +
            "Load the assignment zip your instructor gave you — the one you printed the PDF from — " +
            "rather than the assignment_spec.json on its own."
          );
          return;
        }

        // Loading an assignment starts a fresh submission. Answers have always
        // been cleared here; pages are photographs, so ask before dropping them.
        // Asked last, once the file is known to be one this app will accept:
        // nobody should be asked to discard their pages for a load that is
        // about to be refused.
        if (state.pages.length > 0 && !window.confirm(
          "Loading an assignment clears your current work, including the " +
          `${state.pages.length} page image${state.pages.length === 1 ? '' : 's'} you uploaded.\n\n` +
          "Continue?"
        )) {
          return;
        }

        void clearPageBlobs();
        dropAllPageUrls();
        dropAllCropUrls();
        setState(prev => ({
          ...prev, assignment: json, submissionData: {}, pages: [], layout, crops: {},
        }));
      } catch (err) {
        // A bundle or map problem already says exactly what is wrong and what
        // to do about it; do not bury it under the generic advice.
        if (err instanceof BundleError || err instanceof LayoutMapError) {
          alert(err.message);
          return;
        }
        alert(
          "Invalid Assignment File\n\n" +
          "This file doesn't appear to be a valid assignment.\n\n" +
          "Please use the assignment file your course/instructor provided — the zip you printed " +
          "your pages from, or the assignment_spec.json inside it.\n\n" +
          "If you're trying to restore your previous work, use \"Load Work\" instead."
        );
      }
  };

  const handleLoadDemo = () => {
    // Load the demo assignment directly without file upload
    void clearPageBlobs();
    dropAllPageUrls();
    dropAllCropUrls();
    setState(prev => ({
      ...prev, assignment: DEMO_ASSIGNMENT, submissionData: {}, pages: [], layout: null, crops: {},
    }));
    setStatusMessage(DEMO_LOADED_MESSAGE);
    // Clear the message after 5 seconds
    setTimeout(() => setStatusMessage(''), 5000);
  };

  const handleExportWork = async () => {
    if (!state.assignment) return;
    const backup: BackupData = {
      submission_data: state.submissionData,
      assignment_title: state.assignment.title,
      course_code: state.assignment.courseCode,
      exported_at: new Date().toISOString(),
      version: VERSION
    };

    // A backup that omitted the pages would send a student who restores it
    // back out to re-photograph everything, so carry the bitmaps too — and the
    // crops with their sign-off state, so a restore does not send them back
    // through the review either.
    if (state.pages.length > 0 || Object.keys(state.crops).length > 0) {
      setStatusMessage('Packing your pages into the backup...');
      const images: Record<string, string> = {};
      for (const page of state.pages) {
        const pageBlob = await getPageBlob(page.id);
        if (pageBlob) images[page.id] = await blobToDataUri(pageBlob);
      }
      const cropImages: Record<string, string> = {};
      for (const regionId of Object.keys(state.crops)) {
        const cropBlob = await getPageBlob(cropKey(regionId));
        if (cropBlob) cropImages[regionId] = await blobToDataUri(cropBlob);
      }
      backup.pages = state.pages;
      backup.page_images = images;
      backup.layout = state.layout;
      backup.crops = state.crops;
      backup.crop_images = cropImages;
      setStatusMessage('');
    }

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const fileName = `${submissionBaseName(
      `${state.assignment.courseCode}_${state.assignment.title.replace(/\s+/g, '_')}`,
      backup.exported_at,
    )}_backup.json`;
    downloadBlob(blob, fileName);
    // Nothing here knows whether the file was written — on iOS the download is
    // still behind a confirmation the student has not seen yet. Tell them what
    // to do next instead of claiming it is done.
    alert(
      "Backup file created.\n\n" +
      `File: ${fileName}\n\n` +
      "If your browser asks whether to download it, confirm. It saves wherever your " +
      "browser puts downloads — the Files app on a phone, the Downloads folder on a computer.\n\n" +
      "You can also upload this JSON to your LMS (Canvas, etc.) as a backup of your work."
    );
  };

  const handleLoadWork = (file: File) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const json = JSON.parse(e.target?.result as string);

        // Check if user accidentally loaded an assignment file instead of a backup
        if (json.problems && json.courseCode && !json.submission_data) {
          alert(
            "Wrong file type!\n\n" +
            "You selected an ASSIGNMENT file (used to define problems).\n\n" +
            "To restore your work, use a BACKUP file instead.\n" +
            "Backup files are named like: CourseCode_Title_backup.json\n\n" +
            "To load an assignment, use 'Upload assignment' in the Assignment section above."
          );
          return;
        }

        // Validate backup format
        if (!json.submission_data || !json.course_code) {
          alert(
            "Invalid backup file format.\n\n" +
            "Make sure you're loading a backup file created by 'Save Backup'.\n" +
            "Backup files contain your answers and are named: CourseCode_Title_backup.json"
          );
          return;
        }

        const backupData = json as BackupData;

        // We need the assignment structure to render
        if (!state.assignment && !window.confirm(
          "You haven't loaded an assignment file yet.\n\n" +
          "This backup might not display correctly without the original assignment structure.\n\n" +
          "Recommended: First upload the assignment file, then load your backup.\n\n" +
          "Continue anyway?"
        )) {
          return;
        }

        // Logic to verify course code match if assignment exists
        if (state.assignment && state.assignment.courseCode !== backupData.course_code) {
          if (!window.confirm(
            `Course code mismatch!\n\n` +
            `Backup is for: ${backupData.course_code}\n` +
            `Loaded assignment is: ${state.assignment.courseCode}\n\n` +
            `This backup may not match the current assignment. Continue anyway?`
          )) {
            return;
          }
        }

        // Pages, when the backup carries them. Written back into IndexedDB so
        // they behave exactly like freshly uploaded pages from here on.
        const restoredPages = Array.isArray(backupData.pages) ? backupData.pages : [];
        const restoredCrops = backupData.crops ?? {};
        if (restoredPages.length > 0 || Object.keys(restoredCrops).length > 0) {
          setStatusMessage('Restoring your pages...');
          await clearPageBlobs();
          dropAllPageUrls();
          dropAllCropUrls();
          for (const page of restoredPages) {
            const dataUri = backupData.page_images?.[page.id];
            if (!dataUri) continue;
            try {
              const pageBlob = dataUriToBlob(dataUri);
              await putPageBlob(page.id, pageBlob);
              setPageUrl(page.id, pageBlob);
            } catch (err) {
              console.error(`Could not restore page ${page.id}`, err);
            }
          }
          for (const regionId of Object.keys(restoredCrops)) {
            const dataUri = backupData.crop_images?.[regionId];
            if (!dataUri) continue;
            try {
              const cropBlob = dataUriToBlob(dataUri);
              await putPageBlob(cropKey(regionId), cropBlob);
              setCropUrl(regionId, cropBlob);
            } catch (err) {
              console.error(`Could not restore crop ${regionId}`, err);
            }
          }
          setStatusMessage('');
        }

        setState(prev => ({
          ...prev,
          submissionData: backupData.submission_data,
          pages: restoredPages.length > 0 ? renumberPages(restoredPages) : prev.pages,
          layout: backupData.layout ?? prev.layout,
          crops: Object.keys(restoredCrops).length > 0 ? restoredCrops : prev.crops,
          lastSaved: new Date().toISOString()
        }));
        alert("Work restored successfully!");
      } catch (err) {
        alert(
          "Could not read file.\n\n" +
          "Make sure the file is a valid JSON backup created by this app.\n" +
          "Backup files are named: CourseCode_Title_backup.json"
        );
      }
    };
    reader.readAsText(file);
  };

  const handleClearWork = () => {
    if (window.confirm("Are you sure you want to clear all work? This cannot be undone.")) {
      if (window.confirm("Really delete everything? Type 'YES' to confirm if you are unsure, or just click OK.")) {
         localStorage.removeItem(STORAGE_KEY);
         void clearPageBlobs();
         dropAllPageUrls();
         dropAllCropUrls();
         setState({
            assignment: null,
            submissionData: {},
            pages: [],
            layout: null,
            crops: {},
            viewMode: 'edit',
            lastSaved: null,
            privacyAcknowledged: true
         });
      }
    }
  };

  // Returns the raw PDF bytes, or null on error (caller handles overlay/cleanup).
  const buildPdfBytes = async (
    onPageProgress: (current: number, total: number) => void
  ): Promise<Uint8Array | null> => {
    const html2canvasLib = html2canvas;
    const jsPDFLib = jsPDF;

    const pdfContent = document.getElementById('pdf-content');
    if (!pdfContent) {
      alert("PDF content element not found. Please refresh and try again.");
      return null;
    }

    const captureWrapper = document.createElement('div');
    captureWrapper.style.cssText = 'position:fixed;left:-99999px;top:0;pointer-events:none;z-index:-9999;';
    const clone = pdfContent.cloneNode(true) as HTMLElement;
    captureWrapper.appendChild(clone);
    document.body.appendChild(captureWrapper);

    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    try {
      const clonePages = Array.from(clone.querySelectorAll('.pdf-page')) as HTMLElement[];
      if (clonePages.length === 0) throw new Error('No pages found in PDF content');

      onPageProgress(0, clonePages.length);
      const containerRect = clone.getBoundingClientRect();
      let pdf: any = null;

      for (let i = 0; i < clonePages.length; i++) {
        onPageProgress(i + 1, clonePages.length);
        const pageEl = clonePages[i];
        const pageRect = pageEl.getBoundingClientRect();
        const cropX = pageRect.left - containerRect.left;
        const cropY = pageRect.top - containerRect.top;
        const cropW = pageRect.width;
        const cropH = pageRect.height;

        if (cropW === 0 || cropH === 0) {
          throw new Error(`Page ${i + 1} has zero dimensions (${cropW}×${cropH})`);
        }

        const canvas = await html2canvasLib(clone, {
          scale: 2,
          useCORS: true,
          scrollX: 0,
          scrollY: 0,
          x: cropX,
          y: cropY,
          width: cropW,
          height: cropH,
        });

        const pdfPageWidth = 210;
        const pdfPageHeight = canvas.width > 0
          ? (canvas.height / canvas.width) * pdfPageWidth
          : 297;

        if (!isFinite(pdfPageHeight) || pdfPageHeight <= 0) {
          throw new Error(`Page ${i + 1}: invalid canvas size ${canvas.width}×${canvas.height}`);
        }

        if (i === 0) {
          pdf = new jsPDFLib({ unit: 'mm', format: [pdfPageWidth, pdfPageHeight], orientation: 'portrait' });
        } else {
          pdf.addPage([pdfPageWidth, pdfPageHeight]);
        }

        const imgData = canvas.toDataURL('image/jpeg', 0.98);
        pdf.addImage(imgData, 'JPEG', 0, 0, pdfPageWidth, pdfPageHeight);
      }

      return pdf.output('arraybuffer') as Uint8Array;
    } finally {
      document.body.removeChild(captureWrapper);
    }
  };

  const handleDownloadForGradescope = async () => {
    if (!state.assignment) return;
    setPdfProgress({ active: true, phase: 'pdf', current: 0, total: 0 });
    setStatusMessage("Generating submission package...");

    try {
      // Phase 1: build the PDF — an ELECTRONIC submission only.
      //
      // A handwritten submission carries no PDF (see `submissionPackage`), so it
      // does not build one. That is not only bytes saved: rasterising the print
      // view is by far the slowest thing this handler does, and it is the step a
      // student waits through on a phone. A handwritten submission now goes
      // straight to packaging.
      let pdfBytes: Uint8Array | undefined;
      if (!isHandwritten) {
        const rendered = await buildPdfBytes((current, total) => {
          setPdfProgress({ active: true, phase: 'pdf', current, total });
          setStatusMessage(`Generating PDF... Page ${current} of ${total}`);
        });
        if (!rendered) return;
        pdfBytes = rendered;
      }

      // Phase 2 and 3: the payload and the archive.
      //
      // Both live in `services/submissionPackage` now rather than here. What
      // this handler owns is the browser: the progress overlay, the blob store
      // the bitmaps come out of, the download, and the messages. The package
      // itself is built by a function that can also be called by a test, which
      // is the only way the artefact this app exists to produce can be opened
      // and checked without a person clicking a button.
      setPdfProgress({ active: true, phase: 'packaging', current: 0, total: 0 });
      setStatusMessage("Packaging submission...");

      const built = await buildSubmissionPackage(
        {
          assignment: state.assignment,
          submissionData: state.submissionData,
          isHandwritten,
          layoutId: state.layout?.computedLayoutId ?? null,
          pages: state.pages,
          crops: state.crops,
        },
        { pdfBytes, readBlob: getPageBlob, downsampleImage },
      );
      const baseName = built.baseName;

      // Phase 2a: say what is missing, BEFORE the file is written.
      //
      // The only statement the student used to get was the `alert` below, which
      // fires after `downloadBlob` has already saved the file — by which point
      // they may have closed the tab. A completeness statement there is too late
      // to act on, so this one is here.
      //
      // Counted from the layout map, which has been in hand since the assignment
      // loaded, and against `built.entries`, which is what the archive actually
      // holds rather than what the crop record claims. See
      // `services/completeness.ts` for why neither of those is the QR.
      //
      // **It informs and never blocks.** Cancelling downloads nothing and leaves
      // every photograph, crop and sign-off exactly where it was; continuing
      // builds the same bytes it would have built with no dialog at all.
      const shortfall = completenessMessage(
        submissionCompleteness(state.layout, state.crops, built.entries));
      if (shortfall) {
        setPdfProgress({ active: false, phase: 'pdf', current: 0, total: 0 });
        setStatusMessage('');
        if (!window.confirm(shortfall)) {
          setStatusMessage('Nothing was downloaded — add the missing answers and try again.');
          setTimeout(() => setStatusMessage(''), 8000);
          return;
        }
        setPdfProgress({ active: true, phase: 'packaging', current: 0, total: 0 });
        setStatusMessage('Packaging submission...');
      }

      const zipBlob = await built.zip.generateAsync({ type: 'blob', ...SUBMISSION_ZIP_OPTIONS });

      downloadBlob(zipBlob, `${baseName}.zip`);

      setStatusMessage("Submission package created — confirm the download if your browser asks.");
      alert(
        `Submission package created.\n\n` +
        `File: ${baseName}.zip\n\n` +
        `If your browser asks whether to download it, confirm. It saves wherever your ` +
        `browser puts downloads — the Files app on a phone, the Downloads folder on a computer.\n\n` +
        // **A handwritten submission contains no PDF**, and this sentence told
        // every handwritten student that it did. The decision not to build one
        // is in `submissionPackage` — `PrintView` never receives the pages or
        // the crops, so the PDF would be the blank question paper — and this
        // line was written before that decision and never revisited. A student
        // who goes looking for the PDF it promises finds page photographs and
        // concludes the download went wrong.
        (isHandwritten
          ? `This ZIP contains your page photographs, the answers cut from ` +
            `them, and your submission data.\n`
          : `This ZIP contains your PDF and submission data.\n`) +
        `Upload the ZIP file to Gradescope to submit your assignment.\n\n` +
        `Check you have the file before you close this page.`
      );
      setTimeout(() => setStatusMessage(''), 6000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("Submission package error:", error);
      // A bad course encryption key is not something the student can retry
      // their way out of — show the instruction on its own.
      if (error instanceof Error && error.name === GB2_KEY_ERROR) {
        setStatusMessage("Assignment file problem — submission not created.");
        alert(msg);
      } else {
        setStatusMessage("Error generating submission.");
        alert(`There was an error generating your submission:\n\n${msg}\n\nPlease refresh the page and try again.`);
      }
    } finally {
      setPdfProgress({ active: false, phase: 'pdf', current: 0, total: 0 });
    }
  };

  const acceptPrivacy = () => {
    localStorage.setItem(PRIVACY_KEY, 'true');
    setState(s => ({ ...s, privacyAcknowledged: true }));
    setShowPrivacyModal(false);
  };

  // Below lg the shell is one long document scroll: the sidebar stacks on top
  // and the content follows it. Pinning the shell to the viewport height at
  // every width (as `h-screen overflow-hidden` used to) let the sidebar's
  // `h-full` claim the whole screen, squeezing the content pane — and with it
  // the page uploader — to zero height on phones.
  return (
    <div className="flex min-h-screen flex-col bg-gray-50 font-sans lg:h-screen lg:flex-row lg:overflow-hidden">

      {/* Submission Generation Overlay */}
      {pdfProgress.active && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/75 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-8 flex flex-col items-center gap-5 w-80 text-center">
            {/* Spinner */}
            <svg className="animate-spin w-12 h-12 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
            </svg>
            <div>
              <p className="text-gray-900 font-semibold text-lg">
                {pdfProgress.phase === 'packaging' ? 'Packaging Submission' : 'Generating PDF'}
              </p>
              <p className="text-gray-500 text-sm mt-1">Please wait — do not close this tab</p>
            </div>
            {/* Step indicators */}
            <div className="w-full flex items-center gap-2 text-xs">
              <div className={`flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded ${pdfProgress.phase === 'pdf' ? 'bg-blue-50 text-blue-700 font-semibold' : 'bg-green-50 text-green-700'}`}>
                <span>{pdfProgress.phase === 'pdf' ? '⏳' : '✓'}</span>
                <span>Rendering PDF</span>
              </div>
              <div className="text-gray-300">→</div>
              <div className={`flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded ${pdfProgress.phase === 'packaging' ? 'bg-blue-50 text-blue-700 font-semibold' : 'bg-gray-50 text-gray-400'}`}>
                <span>{pdfProgress.phase === 'packaging' ? '⏳' : '○'}</span>
                <span>Building ZIP</span>
              </div>
            </div>
            {pdfProgress.phase === 'pdf' && pdfProgress.total > 0 && (
              <>
                <div className="w-full bg-gray-200 rounded-full h-2.5">
                  <div
                    className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                    style={{ width: `${Math.round((pdfProgress.current / pdfProgress.total) * 100)}%` }}
                  />
                </div>
                <p className="text-gray-600 text-sm font-medium">
                  Page {pdfProgress.current} of {pdfProgress.total}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Mobile Warning Banner — in flow on a phone, where a fixed banner
          would sit on top of the sidebar header and hide the version line.
          Fixed from lg up, where it is one line and the header clears it.
          A handwritten assignment is photographed on the phone, so the
          desktop advice is wrong there; anything else — including no
          assignment loaded yet — keeps it. */}
      {showMobileBanner && (
        <div className="w-full lg:fixed lg:top-0 lg:left-0 lg:right-0 bg-amber-500 text-amber-950 p-3 z-50 shadow-lg">
          <div className="flex items-center justify-between gap-3 max-w-4xl mx-auto">
            <div className="flex items-center gap-3">
              {isHandwritten
                ? <Smartphone className="w-5 h-5 flex-shrink-0" />
                : <Monitor className="w-5 h-5 flex-shrink-0" />}
              <p className="text-sm font-medium">
                {isHandwritten
                  ? 'Your phone is the right device for this. Photograph your handwritten pages right here. One note: files you save or download land in your Downloads or Files app, so that is where to look for them.'
                  : 'For the best experience, use a desktop or laptop. Files you download can be hard to find on mobile.'}
              </p>
            </div>
            <button
              onClick={() => setShowMobileBanner(false)}
              className="p-1 hover:bg-amber-600 rounded transition-colors flex-shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <Sidebar
        state={state}
        onLoadAssignment={handleLoadAssignment}
        onLoadDemo={handleLoadDemo}
        onLoadWork={handleLoadWork}
        onExportWork={handleExportWork}
        onClearWork={handleClearWork}
        onToggleView={() => setState(s => ({ ...s, viewMode: s.viewMode === 'edit' ? 'print' : 'edit' }))}
        onDownloadForGradescope={handleDownloadForGradescope}
        statusMessage={statusMessage}
      />

      {/* Main Content */}
      <div className="flex-1 lg:overflow-y-auto relative scroll-smooth" id="main-scroll">
        
        {/* Edit Mode View */}
        {state.viewMode === 'edit' && (
          <div className="max-w-4xl mx-auto p-6 lg:p-12 pb-action-bar">
            {!state.assignment ? (
              <div className="flex flex-col items-center justify-center min-h-[60vh] text-center text-gray-400 py-8">
                <h2 className="text-xl font-semibold text-gray-600 mb-6">
                  Welcome — let's get started
                </h2>

                {/* How-To Guide */}
                <div className="max-w-lg mb-8 text-left bg-blue-50 border border-blue-200 rounded-lg p-5 shadow-sm">
                  <h3 className="font-bold text-blue-800 mb-3 text-center">How to Submit Your Assignment</h3>
                  <ol className="space-y-3 text-sm text-blue-900">
                    <li className={`flex items-start gap-3 p-2 rounded ${state.assignment ? 'bg-green-50' : 'bg-blue-100'}`}>
                      <span className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0 ${state.assignment ? 'bg-green-500 text-white' : 'bg-blue-600 text-white animate-pulse'}`}>1</span>
                      <span><strong>Load assignment</strong> - Upload the assignment file your instructor provided — the zip you printed your pages from (or try the demo)</span>
                    </li>
                    <li className="flex items-start gap-3 p-2 rounded bg-gray-50">
                      <span className="w-6 h-6 rounded-full bg-gray-400 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>
                      <span><strong>Complete your work</strong> - Fill in answers for each problem</span>
                    </li>
                    <li className="flex items-start gap-3 p-2 rounded bg-gray-50">
                      <span className="w-6 h-6 rounded-full bg-gray-400 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">3</span>
                      <span><strong>Download &amp; Submit</strong> - Click <em>Download for Gradescope</em> to get a single ZIP file, then upload that ZIP to Gradescope</span>
                    </li>
                  </ol>
                  <div className="mt-4 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                    <strong>Tip:</strong> Your work auto-saves in this browser. Use "Save Backup" to keep a copy you can restore later.
                  </div>
                </div>

                <div className="flex flex-col items-center gap-3">
                    <p className="text-sm text-gray-600 font-medium">Upload your assignment file from the sidebar, or try the demo:</p>
                    <button
                      onClick={handleLoadDemo}
                      className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white rounded-lg shadow-lg transition-all font-medium"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                      </svg>
                      Try Demo Assignment
                    </button>
                    <p className="text-xs text-gray-400 max-w-xs">
                      Explore all features with a sample math assignment
                    </p>
                  </div>
              </div>
            ) : (
              <>
                 <div className="mb-8 border-b border-gray-200 pb-6">
                    <div className="text-sm font-bold text-blue-800 uppercase tracking-wide mb-1">{state.assignment.courseCode}</div>
                    <h1 className="text-3xl font-serif font-bold text-gray-900 mb-4">{state.assignment.title}</h1>
                    {state.assignment.preamble && (
                        <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 text-blue-900 text-sm leading-relaxed">
                            <strong>Instructions:</strong> {state.assignment.preamble}
                        </div>
                    )}
                 </div>

                 {/* Handwritten assignments answer on paper: the pages are the
                     submission, so the page pool leads. Electronic assignments
                     never reach this branch and are untouched. */}
                 {isHandwritten && (
                   <PageUploader
                     pages={state.pages}
                     pageUrls={pageUrls}
                     onAddPage={handleAddPage}
                     onReplacePage={handleReplacePage}
                     onRemovePage={handleRemovePage}
                     onMovePage={handleMovePage}
                     onRotatePage={handleRotatePage}
                   />
                 )}

                 {/* The review step. Every crop, every time, before submission —
                     not optional and not collapsible. It appears as soon as the
                     map is loaded, so a student sees the empty list of parts
                     they have to fill before they start photographing. */}
                 {isHandwritten && state.layout && (
                   <CropReview
                     layout={state.layout}
                     crops={state.crops}
                     cropUrls={cropUrls}
                     pages={state.pages}
                     onReview={handleReviewCrop}
                     onDirectCapture={handleDirectCapture}
                     onRephotographPage={handleRephotographPage}
                     busy={cropBusy}
                   />
                 )}

                 <div>
                   {state.assignment.problems.map((problem, idx) => (
                     <ProblemRenderer
                       key={idx}
                       problem={problem}
                       problemIndex={idx}
                       submissionData={state.submissionData}
                       onSubmissionChange={handleSubmissionChange}
                     />
                   ))}
                 </div>

                 {/* Floating Bottom Bar — wraps to two rows on a phone rather
                     than letting the buttons spill outside the bar. */}
                 <div className="fixed bottom-0 left-0 right-0 lg:left-[320px] bg-gradient-to-t from-slate-900 to-slate-800 border-t border-slate-700 shadow-2xl z-40 min-h-[5rem] flex items-center pb-safe">
                   <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 max-w-3xl mx-auto w-full px-4 py-3">
                     <button
                       onClick={handleExportWork}
                       className="py-2 px-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-all text-sm"
                     >
                       <Save className="w-4 h-4" />
                       Save Backup
                     </button>
                     <p className="hidden sm:block text-amber-300 text-xs font-medium px-1 text-center">
                       Ready to submit?
                     </p>
                     <button
                       onClick={handleDownloadForGradescope}
                       className="py-3 px-5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold flex items-center justify-center gap-2 transition-all shadow-xl"
                     >
                       <Download className="w-5 h-5" />
                       Download for Gradescope
                     </button>
                     <button
                       onClick={() => setState(s => ({ ...s, viewMode: 'print' }))}
                       className="py-2 px-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-all text-sm"
                     >
                       <ChevronLeft className="w-4 h-4 rotate-180" />
                       Preview
                     </button>
                   </div>
                 </div>
              </>
            )}
          </div>
        )}

        {/* Print Preview Mode — always rendered so html2canvas can capture #pdf-content
            from edit mode. When not in print mode, fixed off-screen so it is invisible
            and non-interactive but still laid out by the browser. */}
        <div
          className="flex flex-col bg-gray-500 min-h-full"
          style={state.viewMode !== 'print' ? { position: 'fixed', left: '-99999px', top: 0, width: '210mm', pointerEvents: 'none', zIndex: -1 } : {}}
        >
           {state.assignment && (
               <>
                   {/* Scrollable Preview Area */}
                   <div className="flex-1 overflow-y-auto p-8 pb-action-bar flex justify-center">
                       <div className="shadow-2xl">
                           <PrintView
                             assignment={state.assignment}
                             submissionData={state.submissionData}
                           />
                       </div>
                   </div>

                   {/* Fixed Download Bar - Always visible at bottom */}
                   <div className="fixed bottom-0 left-0 right-0 lg:left-[320px] bg-gradient-to-t from-slate-900 to-slate-800 border-t border-slate-700 shadow-2xl z-40 min-h-[5rem] flex items-center pb-safe">
                     <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 max-w-3xl mx-auto w-full px-4 py-3">
                       <button
                         onClick={() => setState(s => ({ ...s, viewMode: 'edit' }))}
                         className="py-2 px-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-all text-sm"
                       >
                         <ChevronLeft className="w-4 h-4" />
                         Back
                       </button>
                       <button
                         onClick={handleDownloadForGradescope}
                         className="py-3 px-5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold flex items-center justify-center gap-2 transition-all shadow-xl"
                       >
                         <Download className="w-5 h-5" />
                         Download for Gradescope
                       </button>
                     </div>
                   </div>
               </>
           )}
        </div>

      </div>

      {/* Privacy Modal */}
      {showPrivacyModal && <PrivacyNotice onAccept={acceptPrivacy} />}
    </div>
  );
};

export default App;