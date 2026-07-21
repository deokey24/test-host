document.addEventListener('DOMContentLoaded', function () {
  var canvas = document.querySelector('.chart-canvas');
  var bars = document.querySelector('.chart-bars');
  var svg = canvas ? canvas.querySelector('.chart-line-svg') : null;
  if (!canvas || !bars || !svg) return;

  var path = svg.querySelector('.line-path');
  var dots = svg.querySelectorAll('.line-dot');
  var cols = canvas.querySelectorAll('.chart-col');

  var counters = canvas.querySelectorAll('[data-count-to]');
  var percentCounters = document.querySelectorAll('.chart-percent [data-count-to]');
  var allCounters = [].slice.call(counters).concat([].slice.call(percentCounters));

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function animateCount(el, duration) {
    var target = parseInt(el.getAttribute('data-count-to'), 10) || 0;
    var start = null;

    function step(timestamp) {
      if (!start) start = timestamp;
      var progress = Math.min((timestamp - start) / duration, 1);
      var value = Math.round(target * easeOutCubic(progress));
      el.textContent = value;
      if (progress < 1) requestAnimationFrame(step);
      else el.textContent = target;
    }

    requestAnimationFrame(step);
  }

  // 막대의 실제 최종 위치(top)를 그대로 읽어 선을 그린다 — 막대 상단과 항상 정확히 맞물린다.
  function layoutLine() {
    var canvasRect = canvas.getBoundingClientRect();
    if (!canvasRect.width || !canvasRect.height) return;

    svg.setAttribute('viewBox', '0 0 ' + canvasRect.width + ' ' + canvasRect.height);

    var points = [];
    cols.forEach(function (col) {
      var track = col.querySelector('.chart-bar-track');
      if (!track) return;
      var trackRect = track.getBoundingClientRect();
      var h = parseFloat(getComputedStyle(col).getPropertyValue('--h')) / 100 || 0;
      var x = trackRect.left + trackRect.width / 2 - canvasRect.left;
      var y = trackRect.bottom - trackRect.height * h - canvasRect.top;
      points.push([x, y]);
    });

    if (points.length < 2) return;

    var d = 'M' + points.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' L');
    path.setAttribute('d', d);

    var length = path.getTotalLength();
    path.style.strokeDasharray = length;
    if (!played) path.style.strokeDashoffset = length;

    // 마지막(최종) 막대는 초록 알약 라벨로 강조되므로 선의 점은 그 앞 지점까지만 찍는다.
    for (var i = 0; i < dots.length; i++) {
      if (i < points.length - 1) {
        dots[i].setAttribute('cx', points[i][0]);
        dots[i].setAttribute('cy', points[i][1]);
      }
    }
  }

  var played = false;

  function play() {
    if (played) return;
    played = true;
    layoutLine();
    canvas.classList.add('in-view');
    bars.classList.add('in-view');
    path.style.opacity = '1';
    path.style.strokeDashoffset = '0';
    allCounters.forEach(function (el) {
      animateCount(el, 1540);
    });
  }

  layoutLine();

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layoutLine, 150);
  });

  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          play();
          observer.disconnect();
        }
      });
    }, { threshold: 0.25 });
    observer.observe(canvas);
  } else {
    play();
  }
});
