import { useEffect, useRef } from 'react';

const targets = '.on-intro > div, .on-intro > p, .on-section-title h2, .on-seller, .on-category-heading, .on-category-grid > a, .on-experience-heading, .on-experience-copy, .on-order > div, .on-faq h2, .on-catering-band .on-container, .on-map-panel, #contact, .on-serve-strip .on-container, .on-gallery h2, .on-gallery-grid, .on-about-find > div, .on-menu-heading, .on-menu-card, .on-occasions h2, .on-occasions article, .on-inquiry > div, .on-inquiry > form';

/** Visible in SSR/no-JS; only offscreen elements are armed after mount. */
export function useReveal() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || !('IntersectionObserver' in window)) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const seen = new WeakSet<Element>();
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.remove('on-pre-reveal');
        entry.target.classList.add('on-revealed');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -24px 0px' });
    const scan = () => root.querySelectorAll<HTMLElement>(targets).forEach(element => {
      if (seen.has(element)) return;
      seen.add(element);
      if (motion.matches || element.getBoundingClientRect().top < window.innerHeight) return;
      const siblings = Array.from(element.parentElement?.children ?? []);
      element.style.setProperty('--reveal-delay', `${Math.min(siblings.indexOf(element), 3) * 85}ms`);
      element.classList.add('on-reveal', 'on-pre-reveal');
      observer.observe(element);
    });
    const reset = () => { if (motion.matches) root.querySelectorAll('.on-pre-reveal').forEach(element => element.classList.remove('on-pre-reveal')); };
    // A scroll fallback preserves reveals even if an observer never delivers entries.
    const revealVisible = () => root.querySelectorAll<HTMLElement>('.on-pre-reveal').forEach(element => {
      const rect = element.getBoundingClientRect();
      if (rect.top < window.innerHeight) {
        element.classList.remove('on-pre-reveal'); element.classList.add('on-revealed'); observer.unobserve(element);
      }
    });
    window.addEventListener('scroll', revealVisible, { passive: true });
    window.addEventListener('resize', revealVisible);
    scan();
    const mutations = new MutationObserver(scan);
    mutations.observe(root, { childList: true, subtree: true });
    motion.addEventListener('change', reset);
    return () => { window.removeEventListener('scroll', revealVisible); window.removeEventListener('resize', revealVisible); observer.disconnect(); mutations.disconnect(); motion.removeEventListener('change', reset); root.querySelectorAll('.on-pre-reveal').forEach(element => element.classList.remove('on-pre-reveal')); };
  }, []);
  return ref;
}
