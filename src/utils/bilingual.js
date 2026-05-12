/**
 * Bilingual field helpers — fill the missing English/Arabic twin column whenever the
 * admin gives us only one side. Designed to be batch-aware so an entire write (product +
 * descriptions + options) costs one Azure round-trip.
 *
 * Routing rules (content-based, not slot-based)
 * ---------------------------------------------
 *   The schema has an "EN column" (e.g. `title`) and an "AR column" (e.g. `title_ar`).
 *   We do NOT trust which column the admin typed into. We inspect the actual text:
 *
 *     - exactly one side filled, text detected as ENGLISH
 *         → place text in EN column, translate to AR
 *     - exactly one side filled, text detected as ARABIC
 *         → place text in AR column, translate to EN
 *     - both filled (any languages)                → leave alone (manual override wins)
 *     - both empty                                  → leave alone
 *
 *   So admins can type into either field. If they accidentally type Arabic into the
 *   English field, we'll re-route it to the Arabic column and translate the English side.
 *
 *   Language detection is content-based: Arabic Unicode range (U+0600–U+06FF) vs. Latin
 *   letters. This is essentially free, deterministic, and accurate for product copy.
 *   Azure also returns `detectedLanguage` on translate calls, but pre-detecting locally
 *   lets us pick the correct target direction in a single round-trip per string.
 */

const { translateBatch } = require('../services/translation.service');

const EN = 'en';
const AR = 'ar';

function isFilled(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Detect language of free text.
 * - Counts Arabic script chars (U+0600–U+06FF) vs Latin letters.
 * - Ties / no script chars (e.g. pure numbers, emoji) fall back to English so callers
 *   still get a deterministic answer.
 */
// U+0600–U+06FF base Arabic + U+0750–U+077F Arabic Supplement + U+FB50–U+FDFF and
// U+FE70–U+FEFF Arabic Presentation Forms A/B (commonly seen in typed product copy).
const ARABIC_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
const LATIN_RE = /[A-Za-z]/g;

function detectLanguage(text) {
  if (!text || typeof text !== 'string') return EN;
  const arCount = (text.match(ARABIC_RE) || []).length;
  const enCount = (text.match(LATIN_RE) || []).length;
  if (arCount === 0 && enCount === 0) return EN;
  return arCount > enCount ? AR : EN;
}

/**
 * Inspect a single field pair (one EN column, one AR column) and decide what to do.
 * Returns a *plan* but does not mutate the object — if the translation call later fails,
 * we leave the admin's input exactly where they put it. Mutation happens in applyResults
 * after a successful translation.
 *
 * Plan shape: { obj, sourceKey, targetKey, text, from, to }
 *   sourceKey — column that should hold the original text after we're done
 *   targetKey — column that should hold the translation
 */
function planPair(obj, enKey, arKey) {
  if (!obj || typeof obj !== 'object') return null;
  const enFilled = isFilled(obj[enKey]);
  const arFilled = isFilled(obj[arKey]);
  if (enFilled && arFilled) return null;   // manual override
  if (!enFilled && !arFilled) return null; // nothing to do

  const text = (enFilled ? obj[enKey] : obj[arKey]).trim();
  const lang = detectLanguage(text);

  if (lang === EN) {
    return { obj, sourceKey: enKey, targetKey: arKey, text, from: EN, to: AR };
  }
  return { obj, sourceKey: arKey, targetKey: enKey, text, from: AR, to: EN };
}

/**
 * Plan a String[] pair (e.g. ProductOption.options / options_ar). Detects the dominant
 * language of whichever array the admin filled.
 *
 * Returns an array of element-level plans. Like planPair, no mutation happens here —
 * applyResults handles it once translations come back successfully.
 */
function planArrayPair(obj, enKey, arKey) {
  if (!obj || typeof obj !== 'object') return [];
  const enArr = Array.isArray(obj[enKey]) ? obj[enKey].filter(isFilled) : [];
  const arArr = Array.isArray(obj[arKey]) ? obj[arKey].filter(isFilled) : [];
  if (enArr.length === 0 && arArr.length === 0) return [];
  if (enArr.length > 0 && arArr.length > 0) return []; // manual override

  const filled = enArr.length > 0 ? enArr : arArr;
  const lang = detectLanguage(filled.join(' '));
  const sourceKey = lang === EN ? enKey : arKey;
  const targetKey = lang === EN ? arKey : enKey;
  const from = lang;
  const to = lang === EN ? AR : EN;
  const source = filled.map((v) => String(v).trim());

  return source.map((text, index) => ({
    obj,
    isArray: true,
    sourceKey,
    targetKey,
    sourceIndex: index,
    source, // the full source array — used by applyResults to install it once
    text,
    from,
    to,
  }));
}

/**
 * Translate bilingual fields on a payload using a schema.
 *
 * @param {object} payload                The object to mutate.
 * @param {Array} schema                  Field pairs to consider, each one of:
 *   { src: 'title', dst: 'title_ar' }                          // string pair
 *   { src: 'options', dst: 'options_ar', kind: 'arrayOfString' } // string[] pair
 * @returns {Promise<void>}
 */
async function autoTranslate(payload, schema) {
  if (!payload || !Array.isArray(schema) || schema.length === 0) return;
  const stringTasks = [];
  const arrayTasks = [];
  for (const field of schema) {
    if (field.kind === 'arrayOfString') {
      arrayTasks.push(...planArrayPair(payload, field.src, field.dst));
    } else {
      const t = planPair(payload, field.src, field.dst);
      if (t) stringTasks.push(t);
    }
  }
  const allTasks = [...stringTasks, ...arrayTasks];
  if (allTasks.length === 0) return;

  await applyResults(allTasks);
}

/**
 * Translate bilingual fields across many payloads in a single batched call.
 * Useful for ProductDescription / ProductOption arrays where one product write needs
 * to translate N child rows. One Azure round-trip instead of N.
 *
 * @param {object[]} payloads
 * @param {Array} schema
 */
async function autoTranslateMany(payloads, schema) {
  if (!Array.isArray(payloads) || payloads.length === 0) return;
  if (!Array.isArray(schema) || schema.length === 0) return;

  const tasks = [];
  for (const payload of payloads) {
    for (const field of schema) {
      if (field.kind === 'arrayOfString') {
        tasks.push(...planArrayPair(payload, field.src, field.dst));
      } else {
        const t = planPair(payload, field.src, field.dst);
        if (t) tasks.push(t);
      }
    }
  }
  await applyResults(tasks);
}

async function applyResults(tasks) {
  if (tasks.length === 0) return;
  const results = await translateBatch(tasks.map((t) => ({ text: t.text, from: t.from, to: t.to })));

  // Pass 1: install source arrays into the routed column for any array tasks whose
  // translation succeeded. We dedupe by (obj, sourceKey) since each array generates
  // multiple element-level tasks.
  const installedArrays = new Set();

  results.forEach((r, i) => {
    const task = tasks[i];
    if (!r || r.translated !== true || !r.text) return; // failure → leave admin input alone

    if (task.isArray) {
      const key = `${task.sourceKey}`; // unique per task.obj already
      const slot = `${objectId(task.obj)}|${task.sourceKey}|${task.targetKey}`;
      if (!installedArrays.has(slot)) {
        installedArrays.add(slot);
        // Route the source array into the correct column, blank the other so they end
        // up the same length once translations land below.
        task.obj[task.sourceKey] = [...task.source];
        task.obj[task.targetKey] = new Array(task.source.length).fill('');
      }
      task.obj[task.targetKey][task.sourceIndex] = r.text;
    } else {
      // String pair: route source text + write translation to target.
      task.obj[task.sourceKey] = task.text;
      task.obj[task.targetKey] = r.text;
    }
  });
}

// Lightweight object identity helper so we can key a Set on (object, ...). WeakMap-based
// so it doesn't leak references after the request finishes.
const _ids = new WeakMap();
let _idCounter = 0;
function objectId(o) {
  let id = _ids.get(o);
  if (id === undefined) { id = ++_idCounter; _ids.set(o, id); }
  return id;
}

module.exports = {
  autoTranslate,
  autoTranslateMany,
  detectLanguage,
};
