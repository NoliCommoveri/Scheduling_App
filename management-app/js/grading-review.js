/* Module: grading-review.js — Grading Assistant Phase 5.
 * Per TDS_Slice_Grading_Assistant.md §9 Phase 5: the parent's review
 * surface. Lists AI-graded proposals (worker/index.js's
 * GET /api/grading/reviews), shows the captured photo and per-item
 * verdicts, and lets a parent accept a proposal as-is or override its score
 * and feedback before it lands on the assignment
 * (POST /api/grading/review/:id/decision).
 *
 * §0.1: this file never writes `assignments.grade` itself — it only calls
 * the decision route, which reaches `grade` through the same completion
 * path a device's own submission would use.
 */

const GradingReview = (() => {
  const COUNTED_VERDICTS = new Set(['CORRECT', 'PARTIAL', 'INCORRECT']);
  const VERDICT_LABELS = {
    CORRECT: 'Correct', PARTIAL: 'Partial', INCORRECT: 'Incorrect',
    BLANK: 'Blank', UNSURE: 'Unsure — needs your eyes',
  };
  const STATE_LABELS = {
    proposed: 'Needs review', accepted: 'Accepted', overridden: 'Overridden', failed: 'Failed',
  };

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function formatTime(ms) {
    return ms ? new Date(ms).toLocaleString() : '—';
  }

  // Not stored on the row (worker/index.js only persists the earned count,
  // §1.1) — recomputed here the same way grading-core.js's normalizeScore
  // does, so the review shows "3 / 4" instead of a bare "3".
  function outOf(items) {
    if (!Array.isArray(items)) return 0;
    return items.filter((it) => COUNTED_VERDICTS.has(it && it.verdict)).length;
  }

  async function render(root) {
    root.innerHTML = `
      <h2>Grading review</h2>
      <p>Worksheets an AI has proposed a grade for. Accept a proposal as-is, or
         override the score and feedback before it lands on the assignment.</p>
      <label>Show
        <select class="review-filter">
          <option value="proposed" selected>Needs review</option>
          <option value="">All</option>
          <option value="accepted">Accepted</option>
          <option value="overridden">Overridden</option>
          <option value="failed">Failed</option>
        </select>
      </label>
      <p class="review-status" role="status">Loading…</p>
      <ul class="grading-review-list"></ul>
    `;
    const statusEl = root.querySelector('.review-status');
    const listEl = root.querySelector('.grading-review-list');
    const filterEl = root.querySelector('.review-filter');

    const { token } = await Sync.getConfig();
    if (!token) {
      statusEl.textContent = 'Set your sync token in Settings first — grading review uses the same credential.';
      return;
    }

    async function load() {
      statusEl.hidden = false;
      statusEl.textContent = 'Loading…';
      listEl.innerHTML = '';
      try {
        const state = filterEl.value;
        const qs = state ? `?state=${encodeURIComponent(state)}` : '';
        const { reviews, truncated } = await Sync.api(`/api/grading/reviews${qs}`);
        statusEl.hidden = true;
        renderList(listEl, reviews, load);
        if (truncated) {
          const p = document.createElement('p');
          p.className = 'row-meta';
          p.textContent = `Showing the first ${reviews.length} — narrow the filter to see more.`;
          listEl.before(p);
        }
      } catch (err) {
        statusEl.hidden = false;
        statusEl.textContent = `Could not load reviews: ${err.message}`;
      }
    }

    filterEl.addEventListener('change', load);
    await load();
  }

  function renderList(listEl, reviews, reload) {
    if (reviews.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'Nothing to review.';
      listEl.appendChild(p);
      return;
    }
    for (const review of reviews) {
      listEl.appendChild(buildReviewRow(review, reload));
    }
  }

  function buildReviewRow(review, reload) {
    const item = document.createElement('li');
    item.className = 'list-row grading-review-row';

    const denom = outOf(review.items);
    const scoreText = review.proposedScore == null ? '—' : `${review.proposedScore} / ${denom}`;
    const decided = review.state === 'accepted' || review.state === 'overridden';

    item.innerHTML = `
      <div class="row-text">
        <span class="row-title">
          ${escapeHtml(review.childName || review.childId)} — ${escapeHtml(review.assignmentTitle || review.assignmentId)}
        </span>
        <span class="row-meta row-meta-inline">
          <span>${escapeHtml(review.assignmentDate || '')}</span>
          <span>${escapeHtml(review.assignmentCourse || '')}</span>
          <span>Proposed: ${scoreText}</span>
          <span>${escapeHtml(STATE_LABELS[review.state] || review.state)}</span>
          ${review.assignmentRescindedAt ? '<span>Assignment rescinded</span>' : ''}
        </span>
      </div>
      <div class="row-actions">
        <button type="button" data-action="toggle">Details</button>
        ${review.state === 'failed' ? '' : `<button type="button" data-action="accept">${decided ? 'Re-accept' : 'Accept'}</button>`}
        ${review.state === 'failed' ? '' : `<button type="button" data-action="override">Override</button>`}
      </div>
      <p class="row-error" hidden></p>
      <div class="grading-review-detail" hidden></div>
    `;

    const errorEl = item.querySelector('.row-error');
    const detailEl = item.querySelector('.grading-review-detail');
    const toggleBtn = item.querySelector('[data-action="toggle"]');
    const acceptBtn = item.querySelector('[data-action="accept"]');
    const overrideBtn = item.querySelector('[data-action="override"]');

    let detailBuilt = false;
    toggleBtn.addEventListener('click', async () => {
      const opening = detailEl.hidden;
      detailEl.hidden = !opening;
      if (opening && !detailBuilt) {
        detailBuilt = true;
        await buildDetail(detailEl, review);
      }
    });

    if (acceptBtn) {
      acceptBtn.addEventListener('click', async () => {
        errorEl.hidden = true;
        acceptBtn.disabled = true;
        try {
          await Sync.api(`/api/grading/review/${encodeURIComponent(review.assignmentId)}/decision`, {
            method: 'POST',
            body: { action: 'accept' },
          });
          reload();
        } catch (err) {
          acceptBtn.disabled = false;
          errorEl.hidden = false;
          errorEl.textContent = err.message;
        }
      });
    }

    if (overrideBtn) {
      overrideBtn.addEventListener('click', () => {
        detailEl.hidden = false;
        if (!detailBuilt) { detailBuilt = true; buildDetail(detailEl, review); }
        showOverrideForm(detailEl, review, errorEl, reload);
      });
    }

    return item;
  }

  async function buildDetail(detailEl, review) {
    detailEl.innerHTML = '';

    const photoWrap = document.createElement('p');
    photoWrap.textContent = 'Loading photo…';
    detailEl.appendChild(photoWrap);
    loadPhoto(review.assignmentId).then((url) => {
      if (!url) { photoWrap.textContent = 'Photo unavailable.'; return; }
      photoWrap.innerHTML = '';
      const img = document.createElement('img');
      img.className = 'grading-photo';
      img.src = url;
      img.alt = `Captured worksheet for ${review.assignmentTitle || review.assignmentId}`;
      photoWrap.appendChild(img);
    }).catch(() => { photoWrap.textContent = 'Photo unavailable.'; });

    if (review.feedback) {
      const feedback = document.createElement('p');
      feedback.innerHTML = `<strong>Feedback to child:</strong> ${escapeHtml(review.feedback)}`;
      detailEl.appendChild(feedback);
    }

    if (Array.isArray(review.items) && review.items.length > 0) {
      const list = document.createElement('ol');
      list.className = 'grading-items';
      for (const it of review.items) {
        const li = document.createElement('li');
        li.className = `grading-item verdict-${(it.verdict || '').toLowerCase()}`;
        li.innerHTML = `
          <span class="grading-item-verdict">${escapeHtml(VERDICT_LABELS[it.verdict] || it.verdict)}</span>
          <span class="grading-item-transcription">"${escapeHtml(it.transcription)}"</span>
          <span class="grading-item-reason">${escapeHtml(it.reason)}</span>
        `;
        list.appendChild(li);
      }
      detailEl.appendChild(list);
    }

    const meta = document.createElement('p');
    meta.className = 'row-meta';
    meta.textContent = `Model: ${review.model || 'unknown'} · Graded: ${formatTime(review.createdAt)}` +
      (review.reviewedAt ? ` · Reviewed: ${formatTime(review.reviewedAt)}` : '');
    detailEl.appendChild(meta);
  }

  async function loadPhoto(assignmentId) {
    const { token } = await Sync.getConfig();
    const response = await fetch(`/api/grading/review/${encodeURIComponent(assignmentId)}/photo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  function showOverrideForm(detailEl, review, errorEl, reload) {
    let form = detailEl.querySelector('.grading-override-form');
    if (form) return; // already open

    const denom = outOf(review.items);
    form = document.createElement('form');
    form.className = 'grading-override-form';
    form.innerHTML = `
      <label>Score
        <input type="number" name="score" step="any" value="${review.proposedScore == null ? '' : review.proposedScore}" required>
      </label>
      <span class="row-meta">out of ${denom}</span>
      <label>Feedback to child
        <textarea name="feedback" rows="3">${escapeHtml(review.feedback || '')}</textarea>
      </label>
      <div class="row-actions">
        <button type="submit">Save override</button>
        <button type="button" data-action="cancel">Cancel</button>
      </div>
    `;
    form.querySelector('[data-action="cancel"]').addEventListener('click', () => form.remove());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      const score = Number(form.score.value);
      if (!Number.isFinite(score)) {
        errorEl.hidden = false;
        errorEl.textContent = 'Score must be a number.';
        return;
      }
      try {
        await Sync.api(`/api/grading/review/${encodeURIComponent(review.assignmentId)}/decision`, {
          method: 'POST',
          body: { action: 'override', score, feedback: form.feedback.value },
        });
        reload();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = err.message;
      }
    });
    detailEl.appendChild(form);
  }

  return { render };
})();
