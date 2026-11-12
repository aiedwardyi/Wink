// The motion tokens in src/motion.css (IBM Carbon productive motion), for
// motion that script drives. motion.test.ts fails if the two drift apart.
export const MOTION_FAST_MS = 110;
export const MOTION_MODERATE_MS = 150;
export const MOTION_LARGE_MS = 240;
export const EASE_STANDARD = "cubic-bezier(0.2, 0, 0.38, 0.9)";
export const EASE_EXIT = "cubic-bezier(0.2, 0, 1, 0.9)";
// retired: aliases of standard, as in motion.css
export const EASE_ENTRANCE = EASE_STANDARD;
export const EASE_SOFT = EASE_STANDARD;
