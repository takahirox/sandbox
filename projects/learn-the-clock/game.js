(() => {
  const get = id => document.getElementById(id);
  const play = document.querySelector('.play');
  const clock = get('clock');
  const clockDescription = get('clock-description');
  const hourHand = get('hour-hand');
  const minuteHand = get('minute-hand');
  const prompt = get('prompt');
  const readingDescription = get('reading-description');
  const choices = get('choices');
  const answers = [...choices.querySelectorAll('button')];
  const adjustments = get('adjustments');
  const hourAction = get('hour-action');
  const minuteAction = get('minute-action');
  const next = get('next');
  const speak = get('speak');
  const lessons = get('lessons');
  const feedbackText = get('feedback-text');
  const feedbackDetail = get('feedback-detail');
  const modeButtons = { read: get('read-mode'), set: get('set-mode') };
  const lessonButtons = { whole: get('whole-hours'), half: get('half-hours') };

  const hours = {
    whole: [3, 7, 12, 5, 9, 1, 11, 4, 8, 2, 10, 6],
    half: [3, 11, 12, 7, 1, 9, 6, 4, 10, 2, 8, 5],
  };
  const activities = { 30: 'おひるは', 180: 'おやつは', 420: 'おきるのは' };
  const spokenHours = ['じゅうに', 'いち', 'に', 'さん', 'よ', 'ご', 'ろく', 'しち', 'はち', 'く', 'じゅう', 'じゅういち'];
  const indices = { whole: { read: 0, set: 0 }, half: { read: 0, set: 0 } };
  const practiced = { read: false, set: false };
  const period = 12 * 60;
  const center = 180;
  const twoPi = 2 * Math.PI;

  let mode = 'read';
  let lesson = 'whole';
  let time = 0;
  let target = 0;
  let solved = false;
  let drag = null;

  const wrap = (value, size) => ((value % size) + size) % size;
  const hourNumber = hour => hour % 12 || 12;
  const labelTime = minutes => `${hourNumber(Math.floor(minutes / 60))}じ${minutes % 60 ? 'はん' : ''}`;

  function renderClock() {
    // Both hands derive from the same elapsed minutes, even between snap points.
    hourHand.setAttribute('transform', `rotate(${time / 2} 180 180)`);
    minuteHand.setAttribute('transform', `rotate(${(time % 60) * 6} 180 180)`);
  }

  function describeClock() {
    const hour = Math.floor(time / 60);
    const half = time % 60 === 30;
    const shortHand = half ? `${hourNumber(hour)}と${hourNumber(hour + 1)}の あいだ` : hourNumber(hour);
    const description = `とけい。みじかい はりは ${shortHand}、ながい はりは ${half ? 6 : 12}。`;
    clockDescription.textContent = description;
  }

  function feedback(message = '', detail = '') {
    if (feedbackText.textContent !== message) feedbackText.textContent = message;
    if (feedbackDetail.textContent !== detail) feedbackDetail.textContent = detail;
  }

  function showActions() {
    choices.hidden = mode !== 'read' || solved;
    adjustments.hidden = mode !== 'set' || solved;
    minuteAction.hidden = lesson === 'whole';
    next.hidden = !solved;
    play.classList.toggle('is-solved', solved);
    clock.classList.toggle('is-adjustable', mode === 'set' && !solved);
  }

  function newChallenge() {
    endDrag(true);
    solved = false;
    const index = indices[lesson][mode];
    const setting = mode === 'set';
    const hour = hours[lesson][(index + Number(setting)) % 12];
    target = (hour % 12) * 60 + (lesson === 'half' ? 30 : 0);
    const offset = lesson === 'whole' ? 120 : (index === 0 ? 30 : 90);
    time = setting ? wrap(target - offset, period) : target;
    const task = setting ? `${labelTime(target)}に してね` : 'いま なんじ？';
    if (setting && activities[target]) {
      const context = document.createElement('span');
      context.className = 'prompt-context';
      context.textContent = activities[target] + ' ';
      prompt.replaceChildren(context, task);
    } else if (prompt.textContent !== task) {
      prompt.textContent = task;
    }

    if (!setting) {
      const nearby = lesson === 'whole'
        ? [wrap(target - 60, period), target, wrap(target + 60, period)]
        : [target - 30, target, wrap(target + 60, period)];
      answers.forEach((answer, position) => {
        const minutes = nearby[(position + index) % nearby.length];
        answer.value = String(minutes);
        answer.textContent = labelTime(minutes);
        answer.classList.remove('tried');
      });
    }
    feedback();
    renderClock();
    describeClock();
    readingDescription.textContent = setting ? '' : clockDescription.textContent;
    showActions();
  }

  function celebrate() {
    solved = true;
    const focused = document.activeElement;
    const advanceFocus = choices.contains(focused) || adjustments.contains(focused);
    practiced[mode] = true;
    const unlocked = lessons.hidden && practiced.read && practiced.set;
    if (unlocked) lessons.hidden = false;
    showActions();
    feedback('せいかい！', unlocked ? ' はんの れんしゅうも できるよ。' : '');
    if (advanceFocus) next.focus();
  }

  function hint(attempt) {
    return attempt % 60 === target % 60 ? 'みじかい はりを みてね' : 'ながい はりを みてね';
  }

  choices.addEventListener('click', event => {
    const answer = event.target.closest('button');
    if (!answer || solved) return;
    const attempt = Number(answer.value);
    if (attempt === target) {
      celebrate();
      return;
    }
    answers.forEach(button => button.classList.toggle('tried', button === answer));
    feedback(hint(attempt));
  });

  function changePractice(buttons, active) {
    for (const [name, button] of Object.entries(buttons)) button.setAttribute('aria-pressed', String(name === active));
    newChallenge();
  }

  for (const [name, button] of Object.entries(modeButtons)) {
    button.addEventListener('click', () => {
      if (mode === name) return;
      mode = name;
      changePractice(modeButtons, mode);
    });
  }
  for (const [name, button] of Object.entries(lessonButtons)) {
    button.addEventListener('click', () => {
      if (lesson === name) return;
      lesson = name;
      changePractice(lessonButtons, lesson);
    });
  }
  next.addEventListener('click', () => {
    const advanceFocus = document.activeElement === next;
    indices[lesson][mode] = (indices[lesson][mode] + 1) % 12;
    newChallenge();
    if (advanceFocus) (mode === 'read' ? answers[0] : hourAction).focus();
  });

  function settleTime(minutes) {
    time = wrap(minutes, period);
    renderClock();
    describeClock();
    if (time === target) celebrate();
    else feedback(hint(time), ` いまは ${labelTime(time)}。`);
  }

  function bindAdjustment(button, step) {
    const move = direction => {
      if (mode !== 'set' || solved || drag) return;
      settleTime(time + direction * step);
    };
    button.addEventListener('click', () => move(1));
    button.addEventListener('keydown', event => {
      if (['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        move(event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1);
      }
    });
  }
  bindAdjustment(hourAction, 60);
  bindAdjustment(minuteAction, 30);

  function clockPoint(event) {
    const bounds = clock.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * 360 / bounds.width - center;
    const y = (event.clientY - bounds.top) * 360 / bounds.height - center;
    return { x, y, radius: Math.hypot(x, y), angle: Math.atan2(x, -y) * 360 / twoPi };
  }

  function distanceToTip(point, minutesPerTurn, length) {
    const angle = time / minutesPerTurn * twoPi;
    return Math.hypot(point.x - Math.sin(angle) * length, point.y + Math.cos(angle) * length);
  }

  clock.addEventListener('pointerdown', event => {
    if (mode !== 'set' || solved || drag || event.button !== 0) return;
    const point = clockPoint(event);
    if (point.radius < 25 || point.radius > 171) return;
    const shortTip = distanceToTip(point, period, 60);
    const longTip = distanceToTip(point, 60, 90);
    const onNumbers = point.radius >= 106;
    const moveMinute = !onNumbers && longTip <= 34 && longTip < shortTip;
    const onHand = !onNumbers && (moveMinute || shortTip <= 34);
    // Away from the grips, a tap on a number places the short hand at that hour.
    const start = onHand ? time : wrap(Math.round(point.angle / 30) * 60 + time % 60, period);
    drag = { id: event.pointerId, original: time, start, minutes: moveMinute, angle: point.angle, traveled: 0 };
    clock.setPointerCapture(event.pointerId);
    clock.classList.add('is-dragging');
    time = start;
    renderClock();
  });

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const point = clockPoint(event);
    if (point.radius < 25) return;
    // Accumulate the shortest delta so crossing 12 in either direction keeps the hour in sync.
    const delta = wrap(point.angle - drag.angle + 180, 360) - 180;
    // A straight first move across the pivot has no direction, so treat it as clockwise.
    const acrossPivot = drag.minutes && Math.abs(drag.traveled) < 2 && Math.abs(delta) >= 178;
    drag.traveled += acrossPivot ? Math.abs(delta) : delta;
    drag.angle = point.angle;
    const elapsed = drag.minutes ? drag.traveled / 6 : Math.round(drag.traveled / 30) * 60;
    time = wrap(drag.start + elapsed, period);
    renderClock();
  }

  function endDrag(cancel) {
    if (!drag) return;
    const ending = drag;
    drag = null;
    if (clock.hasPointerCapture(ending.id)) clock.releasePointerCapture(ending.id);
    clock.classList.remove('is-dragging');
    if (cancel) {
      time = ending.original;
      renderClock();
      return;
    }
    const step = lesson === 'whole' ? 60 : 30;
    settleTime(Math.round(time / step) * step);
  }

  clock.addEventListener('pointermove', moveDrag);
  clock.addEventListener('pointerup', event => {
    if (event.pointerId !== drag?.id) return;
    moveDrag(event);
    endDrag(false);
  });
  for (const eventName of ['pointercancel', 'lostpointercapture']) {
    clock.addEventListener(eventName, event => {
      if (event.pointerId === drag?.id) endDrag(true);
    });
  }

  speak.hidden = !('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function';
  speak.addEventListener('click', () => {
    try {
      const synthesis = window.speechSynthesis;
      const voices = synthesis.getVoices().filter(voice => voice.localService && /^ja(?:-|$)/i.test(voice.lang));
      const voice = voices.find(voice => voice.lang.toLowerCase() === 'ja-jp') || voices[0];
      if (!voice) return;
      const spokenTime = `${spokenHours[Math.floor(target / 60)]}じ${target % 60 ? 'はん' : ''}`;
      const message = mode === 'read' ? 'いま、なんじ？' : `${activities[target] || ''} ${spokenTime}にしてね。`.trim();
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.voice = voice;
      utterance.lang = 'ja-JP';
      utterance.rate = .9;
      synthesis.cancel();
      synthesis.speak(utterance);
    } catch {
      // Local Japanese voices are optional and may become available later.
    }
  });

  newChallenge();
})();
