// Progressive enhancement only. The page is fully usable without this file.
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Reveal on scroll
  if ('IntersectionObserver' in window && !reduceMotion) {
    root.classList.add('js');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    document.querySelectorAll('.reveal').forEach(function (el, i) {
      // Light stagger for siblings in grids
      el.style.transitionDelay = ((i % 3) * 70) + 'ms';
      io.observe(el);
    });
  }

  // Header border once scrolled
  var header = document.querySelector('.site-header');
  var onScroll = function () {
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Close the mobile menu after choosing a link, or on Escape / outside click
  var menu = document.querySelector('.nav-menu');
  if (menu) {
    menu.addEventListener('click', function (e) {
      if (e.target instanceof Element && e.target.closest('a')) menu.removeAttribute('open');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.hasAttribute('open')) {
        menu.removeAttribute('open');
        var s = menu.querySelector('summary');
        if (s) s.focus();
      }
    });
    document.addEventListener('click', function (e) {
      if (menu.hasAttribute('open') && e.target instanceof Node && !menu.contains(e.target)) {
        menu.removeAttribute('open');
      }
    });
  }

  // Highlight the nav link for the section in view
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav-links a[href^="#"]'));
  if ('IntersectionObserver' in window && links.length) {
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var current = byId[entry.target.id];
        if (!entry.isIntersecting && current && current.classList.contains('is-active')) {
          current.classList.remove('is-active');
          current.removeAttribute('aria-current');
        }
        if (entry.isIntersecting) {
          links.forEach(function (a) { a.classList.remove('is-active'); a.removeAttribute('aria-current'); });
          var link = byId[entry.target.id];
          if (link) { link.classList.add('is-active'); link.setAttribute('aria-current', 'true'); }
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(byId).forEach(function (id) {
      var section = document.getElementById(id);
      if (section) spy.observe(section);
    });
  }
})();
