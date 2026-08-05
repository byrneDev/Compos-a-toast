export const PLAYER_STYLES = String.raw`/* Compos-a-toast SCORM 1.2 player */
:root {
  color-scheme: light;
  font-family: Inter, "Segoe UI", Arial, sans-serif;
  color: #172033;
  background: #eef2f7;
}

* { box-sizing: border-box; }

html, body { min-height: 100%; margin: 0; }

body { background: #eef2f7; }

button, input { font: inherit; }

button:focus-visible, input:focus-visible {
  outline: 3px solid #2457d6;
  outline-offset: 2px;
}

.app-shell {
  width: min(1180px, 100%);
  margin: 0 auto;
  padding: 1rem;
}

.course-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: .75rem;
}

.course-header h1 { margin: 0; font-size: clamp(1.25rem, 3vw, 2rem); }

.progress-wrap { min-width: min(18rem, 45vw); }
.progress-wrap label { display: block; margin-bottom: .25rem; font-size: .875rem; }
progress { width: 100%; height: 1rem; }

.player-card {
  padding: clamp(.5rem, 2vw, 1.25rem);
  border: 1px solid #ccd5e2;
  border-radius: .75rem;
  background: #fff;
  box-shadow: 0 .25rem 1rem rgb(31 42 68 / 10%);
}

.slide-heading { margin: 0 0 .75rem; font-size: clamp(1.125rem, 2.5vw, 1.6rem); }

.slide-stage {
  position: relative;
  isolation: isolate;
  width: 100%;
  aspect-ratio: var(--course-aspect, 4 / 3);
  overflow: hidden;
  border: 1px solid #aeb9ca;
  background: var(--course-background, #fff);
}

.slide-object { position: absolute; overflow: hidden; }
.slide-object p { margin: 0; white-space: pre-wrap; }
.slide-object img, .slide-object video { display: block; width: 100%; height: 100%; object-fit: contain; }
.slide-object audio { display: block; width: 100%; }
.slide-object .missing-asset {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  padding: .5rem;
  border: 1px dashed #aa3545;
  color: #8a2535;
  background: #fff5f6;
  text-align: center;
}

.interaction-panel {
  margin-top: 1rem;
  padding: 1rem;
  border: 1px solid #ccd5e2;
  border-radius: .5rem;
  background: #f8fafc;
}

.interaction-panel form + form { margin-top: 1.25rem; }
.interaction-panel fieldset { border: 0; margin: 0; padding: 0; }
.interaction-panel legend { margin-bottom: .625rem; font-weight: 700; }
.option { display: flex; align-items: start; gap: .5rem; margin: .45rem 0; }
.fill-blank-label { display: grid; gap: .4rem; }
.fill-blank-label input { width: min(30rem, 100%); padding: .55rem; }
.check-answer { margin-top: .7rem; padding: .5rem .8rem; }
.feedback { min-height: 1.5rem; margin: .6rem 0 0; font-weight: 650; }
.feedback.correct { color: #176536; }
.feedback.incorrect { color: #a12735; }

.hotspot-list { display: flex; flex-wrap: wrap; gap: .5rem; }
.hotspot-choice { padding: .5rem .75rem; }

.player-warning {
  margin: .75rem 0;
  padding: .7rem;
  border-left: .3rem solid #9a6400;
  background: #fff5d9;
  color: #6d4600;
}

.player-warning[hidden], .interaction-panel[hidden] { display: none; }

.navigation {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  margin-top: 1rem;
}

.navigation button { min-width: 7rem; padding: .6rem .9rem; }
.slide-counter { text-align: center; }

.noscript-warning { margin: 1rem; padding: 1rem; background: #fff5d9; }

@media (max-width: 680px) {
  .course-header { align-items: stretch; flex-direction: column; }
  .progress-wrap { min-width: 0; }
  .navigation button { min-width: 5rem; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
}
`

export const PLAYER_SCRIPT = String.raw`(() => {
  'use strict';

  const SUSPEND_DATA_LIMIT = 4096;
  const API_SEARCH_LIMIT = 500;
  const course = window.__COMPOS_A_TOAST_COURSE__;

  if (!course || !Array.isArray(course.slides)) {
    document.body.textContent = 'The exported course data could not be loaded.';
    return;
  }

  const configuredMastery = Number(course.scorm && course.scorm.masteryScore);
  const MASTERY_SCORE = Number.isFinite(configuredMastery) && configuredMastery >= 0 && configuredMastery <= 100
    ? configuredMastery
    : 80;
  const allInteractions = course.slides.flatMap((slide) => Array.isArray(slide.interactions) ? slide.interactions : []);
  const gradeableInteractions = allInteractions.filter(isGradeableInteraction);

  const elements = {
    title: document.getElementById('course-title'),
    slideTitle: document.getElementById('slide-title'),
    stage: document.getElementById('slide-stage'),
    interactions: document.getElementById('interactions'),
    previous: document.getElementById('previous-slide'),
    next: document.getElementById('next-slide'),
    counter: document.getElementById('slide-counter'),
    progress: document.getElementById('course-progress'),
    progressLabel: document.getElementById('progress-label'),
    warning: document.getElementById('player-warning')
  };

  const state = {
    index: 0,
    answers: {},
    outcomes: {},
    initializedAt: Date.now(),
    finished: false
  };

  function findApi(startWindow) {
    let cursor = startWindow;
    let attempts = 0;
    while (cursor && attempts < API_SEARCH_LIMIT) {
      try {
        if (cursor.API && typeof cursor.API.LMSInitialize === 'function') return cursor.API;
        if (cursor.parent === cursor) break;
        cursor = cursor.parent;
      } catch (_error) {
        break;
      }
      attempts += 1;
    }
    return null;
  }

  function discoverApi() {
    const parentApi = findApi(window);
    if (parentApi) return parentApi;
    try {
      if (window.opener && !window.opener.closed) return findApi(window.opener);
    } catch (_error) {
      return null;
    }
    return null;
  }

  function truthyScormResult(value) {
    return value === true || value === 'true' || value === '1';
  }

  function createScormAdapter() {
    const api = discoverApi();
    let initialized = false;
    const fallbackKey = 'compos-a-toast:' + String(course.settings && course.settings.id || 'course');

    function call(method, valueA, valueB) {
      if (!api || typeof api[method] !== 'function') return '';
      try {
        if (arguments.length === 1) return api[method]('');
        if (arguments.length === 2) return api[method](valueA);
        return api[method](valueA, valueB);
      } catch (_error) {
        return '';
      }
    }

    return {
      initialize() {
        if (api) initialized = truthyScormResult(call('LMSInitialize'));
        return initialized;
      },
      getValue(name) {
        if (initialized) return String(call('LMSGetValue', name) || '');
        try {
          const saved = JSON.parse(localStorage.getItem(fallbackKey) || '{}');
          return String(saved[name] || '');
        } catch (_error) {
          return '';
        }
      },
      setValue(name, value) {
        const textValue = String(value);
        if (initialized) return truthyScormResult(call('LMSSetValue', name, textValue));
        try {
          const saved = JSON.parse(localStorage.getItem(fallbackKey) || '{}');
          saved[name] = textValue;
          localStorage.setItem(fallbackKey, JSON.stringify(saved));
          return true;
        } catch (_error) {
          return false;
        }
      },
      commit() {
        if (initialized) return truthyScormResult(call('LMSCommit'));
        return true;
      },
      finish() {
        if (!initialized) return true;
        const result = truthyScormResult(call('LMSFinish'));
        initialized = false;
        return result;
      },
      isConnected() { return initialized; }
    };
  }

  const scorm = createScormAdapter();

  function showWarning(message) {
    if (!elements.warning) return;
    elements.warning.hidden = false;
    elements.warning.textContent = message;
  }

  function parseSavedState(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function restoreState() {
    const saved = parseSavedState(scorm.getValue('cmi.suspend_data'));
    const location = Number.parseInt(scorm.getValue('cmi.core.lesson_location'), 10);
    const desiredIndex = saved && Number.isInteger(saved.i) ? saved.i : location;
    if (Number.isInteger(desiredIndex)) {
      state.index = Math.max(0, Math.min(course.slides.length - 1, desiredIndex));
    }
    if (saved && saved.a && typeof saved.a === 'object') state.answers = saved.a;
    if (saved && saved.o && typeof saved.o === 'object') state.outcomes = saved.o;
  }

  function compactState() {
    return { v: 1, i: state.index, a: state.answers, o: state.outcomes };
  }

  function saveState() {
    let serialized = JSON.stringify(compactState());
    if (serialized.length > SUSPEND_DATA_LIMIT) {
      const answeredIds = Object.keys(state.answers);
      const minimal = JSON.stringify({ v: 1, i: state.index, n: answeredIds.length });
      showWarning('Resume data exceeded the SCORM 1.2 4096-character limit. Only the current slide can be restored.');
      console.warn('SCORM 1.2 suspend_data exceeds 4096 characters; saving a compact fallback.');
      serialized = minimal.length <= SUSPEND_DATA_LIMIT ? minimal : JSON.stringify({ v: 1, i: state.index });
    }
    scorm.setValue('cmi.core.lesson_location', String(state.index));
    scorm.setValue('cmi.suspend_data', serialized);
    scorm.commit();
  }

  function percent(value, total) {
    if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
    return Math.max(0, Math.min(100, (value / total) * 100));
  }

  function coordinate(value, total, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !Number.isFinite(total) || total <= 0) return fallback;
    return percent(numeric, total) + '%';
  }

  function applyGeometry(element, geometry, zIndex) {
    const width = Number(course.settings && course.settings.width) || 800;
    const height = Number(course.settings && course.settings.height) || 600;
    const box = geometry || {};
    const left = Number.isFinite(Number(box.left)) ? Number(box.left) : 0;
    const top = Number.isFinite(Number(box.top)) ? Number(box.top) : 0;
    let objectWidth = Number(box.width);
    let objectHeight = Number(box.height);
    if (!Number.isFinite(objectWidth) && Number.isFinite(Number(box.right))) objectWidth = Number(box.right) - left;
    if (!Number.isFinite(objectHeight) && Number.isFinite(Number(box.bottom))) objectHeight = Number(box.bottom) - top;
    element.style.left = coordinate(left, width, '0%');
    element.style.top = coordinate(top, height, '0%');
    element.style.width = coordinate(objectWidth, width, 'auto');
    element.style.height = coordinate(objectHeight, height, 'auto');
    if (Number.isFinite(Number(zIndex))) element.style.zIndex = String(Math.trunc(Number(zIndex)));
  }

  function plainText(primary, htmlFallback) {
    if (typeof primary === 'string' && primary.trim()) return primary;
    if (typeof htmlFallback !== 'string') return '';
    return htmlFallback
      .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function assetPath(object, matchingKinds) {
    const refs = Array.isArray(object.assetRefs) ? object.assetRefs : [];
    const kinds = Array.isArray(matchingKinds) ? matchingKinds : [];
    const packaged = refs.find((ref) => ref && typeof ref.packagePath === 'string' && (kinds.length === 0 || kinds.includes(ref.kind)));
    return packaged ? packaged.packagePath : '';
  }

  function renderObject(object) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slide-object role-' + String(object.role || 'unknown').replace(/[^a-z-]/g, '');
    applyGeometry(wrapper, object.geometry, object.zIndex);
    const label = plainText(object.text, object.html);

    const refs = Array.isArray(object.assetRefs) ? object.assetRefs : [];
    if (object.role === 'image' || refs.some((ref) => ref.kind === 'image')) {
      const source = assetPath(object, ['image']);
      if (source) {
        const image = document.createElement('img');
        image.src = source;
        image.alt = label || String(object.attributes && (object.attributes.alt || object.attributes.title) || '');
        wrapper.appendChild(image);
      } else {
        const missing = document.createElement('span');
        missing.className = 'missing-asset';
        missing.textContent = label || 'Image unavailable';
        wrapper.appendChild(missing);
      }
    } else if (object.role === 'media' || refs.some((ref) => ref.kind === 'audio' || ref.kind === 'video')) {
      const videoSource = assetPath(object, ['video']);
      const audioSource = assetPath(object, ['audio']);
      if (videoSource) {
        const video = document.createElement('video');
        video.src = videoSource;
        video.controls = true;
        video.preload = 'metadata';
        video.setAttribute('aria-label', label || 'Video');
        wrapper.appendChild(video);
      } else if (audioSource) {
        const audio = document.createElement('audio');
        audio.src = audioSource;
        audio.controls = true;
        audio.preload = 'metadata';
        audio.setAttribute('aria-label', label || 'Audio');
        wrapper.appendChild(audio);
      } else {
        const missing = document.createElement('span');
        missing.className = 'missing-asset';
        missing.textContent = label || 'Media unavailable';
        wrapper.appendChild(missing);
      }
    } else if (object.role === 'button') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label || 'Button';
      wrapper.appendChild(button);
    } else {
      const paragraph = document.createElement('p');
      paragraph.textContent = label;
      wrapper.appendChild(paragraph);
    }
    return wrapper;
  }

  function interactionKey(interaction) {
    return String(interaction.id || interaction.objectId || 'interaction');
  }

  function isGradeableInteraction(interaction) {
    if (!interaction || !['multiple-choice', 'fill-blank', 'hotspot'].includes(interaction.type)) return false;
    const answers = Array.isArray(interaction.answers) ? interaction.answers : [];
    const options = Array.isArray(interaction.options) ? interaction.options : [];
    return answers.some((answer) => String(answer || '').trim()) || options.some((option) => option && option.correct === true);
  }

  function feedbackText(interaction, correct) {
    const feedback = interaction.feedback || {};
    if (correct) return plainText(feedback.correct, '') || 'Correct.';
    return plainText(feedback.incorrect, '') || 'That answer is not correct yet.';
  }

  function recordInteraction(interaction, response, correct) {
    const key = interactionKey(interaction);
    state.answers[key] = response;
    state.outcomes[key] = correct ? 1 : 0;
    const interactionIndex = Math.max(0, allInteractions.findIndex((candidate) => interactionKey(candidate) === key));
    scorm.setValue('cmi.interactions.' + interactionIndex + '.id', key.slice(0, 255));
    scorm.setValue('cmi.interactions.' + interactionIndex + '.type', interaction.type === 'fill-blank' ? 'fill-in' : interaction.type === 'hotspot' ? 'performance' : 'choice');
    scorm.setValue('cmi.interactions.' + interactionIndex + '.student_response', Array.isArray(response) ? response.join(',') : String(response));
    scorm.setValue('cmi.interactions.' + interactionIndex + '.result', correct ? 'correct' : 'wrong');
    updateScore(false);
    saveState();
  }

  function setFeedback(node, text, correct) {
    node.textContent = text;
    node.className = 'feedback ' + (correct ? 'correct' : 'incorrect');
    node.setAttribute('role', 'status');
  }

  function optionAnswer(option) {
    return String(option.id || option.text || '').trim();
  }

  function renderMultipleChoice(interaction) {
    const form = document.createElement('form');
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = plainText(interaction.prompt, '') || 'Choose an answer';
    fieldset.appendChild(legend);
    const options = Array.isArray(interaction.options) ? interaction.options : [];
    const expected = options.filter((option) => option.correct === true).map(optionAnswer);
    const multiple = expected.length > 1;
    const key = interactionKey(interaction);

    options.forEach((option, index) => {
      const label = document.createElement('label');
      label.className = 'option';
      const input = document.createElement('input');
      input.type = multiple ? 'checkbox' : 'radio';
      input.name = key;
      input.value = optionAnswer(option);
      input.checked = Array.isArray(state.answers[key]) && state.answers[key].includes(input.value);
      const text = document.createElement('span');
      text.textContent = plainText(option.text, option.html) || 'Option ' + (index + 1);
      label.append(input, text);
      fieldset.appendChild(label);
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'check-answer';
    submit.textContent = 'Check answer';
    const feedback = document.createElement('p');
    feedback.className = 'feedback';
    form.append(fieldset, submit, feedback);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const selected = Array.from(form.querySelectorAll('input:checked')).map((input) => input.value).sort();
      const desired = expected.slice().sort();
      const correct = desired.length > 0 && selected.length === desired.length && selected.every((value, index) => value === desired[index]);
      recordInteraction(interaction, selected, correct);
      setFeedback(feedback, feedbackText(interaction, correct), correct);
    });
    return form;
  }

  function normalizedAnswer(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  function renderFillBlank(interaction) {
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.className = 'fill-blank-label';
    const prompt = document.createElement('span');
    prompt.textContent = plainText(interaction.prompt, '') || 'Enter your answer';
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.value = typeof state.answers[interactionKey(interaction)] === 'string' ? state.answers[interactionKey(interaction)] : '';
    label.append(prompt, input);
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'check-answer';
    submit.textContent = 'Check answer';
    const feedback = document.createElement('p');
    feedback.className = 'feedback';
    form.append(label, submit, feedback);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const expected = (Array.isArray(interaction.answers) ? interaction.answers : []).map(normalizedAnswer);
      const response = input.value;
      const correct = expected.length > 0 && expected.includes(normalizedAnswer(response));
      recordInteraction(interaction, response, correct);
      setFeedback(feedback, feedbackText(interaction, correct), correct);
    });
    return form;
  }

  function renderHotspot(interaction) {
    const form = document.createElement('form');
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = plainText(interaction.prompt, '') || 'Choose a hotspot';
    const list = document.createElement('div');
    list.className = 'hotspot-list';
    const feedback = document.createElement('p');
    feedback.className = 'feedback';
    (Array.isArray(interaction.options) ? interaction.options : []).forEach((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hotspot-choice';
      button.textContent = plainText(option.text, option.html) || 'Hotspot ' + (index + 1);
      button.addEventListener('click', () => {
        const correct = option.correct === true;
        recordInteraction(interaction, optionAnswer(option), correct);
        setFeedback(feedback, feedbackText(interaction, correct), correct);
      });
      list.appendChild(button);
    });
    fieldset.append(legend, list);
    form.append(fieldset, feedback);
    return form;
  }

  function renderInteractions(slide) {
    elements.interactions.replaceChildren();
    const interactions = Array.isArray(slide.interactions) ? slide.interactions : [];
    elements.interactions.hidden = interactions.length === 0;
    interactions.forEach((interaction) => {
      if (interaction.type === 'multiple-choice') elements.interactions.appendChild(renderMultipleChoice(interaction));
      else if (interaction.type === 'fill-blank') elements.interactions.appendChild(renderFillBlank(interaction));
      else if (interaction.type === 'hotspot') elements.interactions.appendChild(renderHotspot(interaction));
      else {
        const note = document.createElement('p');
        note.textContent = plainText(interaction.prompt, '') || 'This interaction requires manual reconstruction.';
        elements.interactions.appendChild(note);
      }
    });
  }

  function renderSlide() {
    if (!course.slides.length) {
      elements.slideTitle.textContent = 'No slides were found';
      elements.stage.replaceChildren();
      elements.previous.disabled = true;
      elements.next.disabled = true;
      return;
    }
    const slide = course.slides[state.index];
    elements.slideTitle.textContent = plainText(slide.title, '') || 'Slide ' + (state.index + 1);
    elements.stage.replaceChildren();
    (Array.isArray(slide.objects) ? slide.objects : [])
      .slice()
      .sort((left, right) => Number(left.zIndex || 0) - Number(right.zIndex || 0))
      .forEach((object) => elements.stage.appendChild(renderObject(object)));
    renderInteractions(slide);
    elements.previous.disabled = state.index <= 0;
    elements.next.disabled = state.index >= course.slides.length - 1;
    elements.counter.textContent = 'Slide ' + (state.index + 1) + ' of ' + course.slides.length;
    elements.progress.max = Math.max(1, course.slides.length);
    elements.progress.value = state.index + 1;
    elements.progressLabel.textContent = Math.round(percent(state.index + 1, course.slides.length)) + '% complete';
    document.title = (plainText(slide.title, '') || 'Slide') + ' – ' + plainText(course.settings.title, 'Course');
    saveState();
  }

  function scoreSummary() {
    const keys = gradeableInteractions.map(interactionKey);
    const answered = keys.reduce((sum, key) => sum + (Object.prototype.hasOwnProperty.call(state.outcomes, key) ? 1 : 0), 0);
    const correct = keys.reduce((sum, key) => sum + (state.outcomes[key] === 1 ? 1 : 0), 0);
    const total = keys.length;
    return { correct, answered, total, percent: total ? Math.round(percent(correct, total)) : 0, allAnswered: answered === total };
  }

  function updateScore(completing) {
    const summary = scoreSummary();
    scorm.setValue('cmi.core.score.min', '0');
    scorm.setValue('cmi.core.score.max', '100');
    scorm.setValue('cmi.core.score.raw', String(summary.percent));
    if (completing) {
      // Policy: no gradeable items means completed; unanswered gradeable items
      // remain incomplete; an all-answered attempt below mastery is failed.
      const status = summary.total === 0
        ? 'completed'
        : !summary.allAnswered
          ? 'incomplete'
          : summary.percent >= MASTERY_SCORE
            ? 'passed'
            : 'failed';
      scorm.setValue('cmi.core.lesson_status', status);
      if (status === 'incomplete') {
        showWarning('This course remains incomplete until all scored interactions are answered.');
      }
      return status;
    }
    return null;
  }

  function formatSessionTime(milliseconds) {
    const maximumSeconds = (9999 * 60 * 60) + (59 * 60) + 59;
    const totalSeconds = Math.min(maximumSeconds, Math.max(0, Math.floor(milliseconds / 1000)));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return String(hours).padStart(4, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  function finish() {
    if (state.finished) return;
    state.finished = true;
    const reachedEnd = course.slides.length === 0 || state.index >= course.slides.length - 1;
    const finalStatus = updateScore(reachedEnd);
    saveState();
    scorm.setValue('cmi.core.session_time', formatSessionTime(Date.now() - state.initializedAt));
    const terminal = ['completed', 'passed', 'failed'].includes(finalStatus);
    scorm.setValue('cmi.core.exit', reachedEnd && terminal ? '' : 'suspend');
    scorm.commit();
    scorm.finish();
  }

  scorm.initialize();
  const currentStatus = scorm.getValue('cmi.core.lesson_status');
  if (!['completed', 'passed', 'failed'].includes(currentStatus)) {
    scorm.setValue('cmi.core.lesson_status', 'incomplete');
  }
  restoreState();

  elements.title.textContent = plainText(course.settings.title, '') || 'Untitled course';
  const width = Math.max(1, Number(course.settings.width) || 800);
  const height = Math.max(1, Number(course.settings.height) || 600);
  elements.stage.style.setProperty('--course-aspect', String(width) + ' / ' + String(height));
  if (typeof course.settings.backgroundColor === 'string' && /^#[0-9a-f]{3,8}$/i.test(course.settings.backgroundColor)) {
    elements.stage.style.setProperty('--course-background', course.settings.backgroundColor);
  }

  elements.previous.addEventListener('click', () => {
    if (state.index > 0) { state.index -= 1; renderSlide(); }
  });
  elements.next.addEventListener('click', () => {
    if (state.index < course.slides.length - 1) { state.index += 1; renderSlide(); }
  });
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (event.key === 'ArrowLeft') elements.previous.click();
    if (event.key === 'ArrowRight') elements.next.click();
  });
  window.addEventListener('pagehide', finish);
  window.addEventListener('beforeunload', finish);
  renderSlide();
})();
`
