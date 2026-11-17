// Below md the drawer button floats over the leading corner of every page
// header, so its own inset and the room each header leaves for it have to come
// from one place. 14px + the button's 6px padding drops the glyph on the 20px
// `px-5` edge those headers already use. The button's box ends at 44px and its
// unread badge hangs 4px past that, so headers reserve 52px: box, badge and a
// 4px gap, or a "9+" lands on the page title. `top-[15px]` centers the 30px
// button on the 60px leading row the same headers declare below.
//
// Kept as plain literal strings so Tailwind's scanner sees every class.

/** Where the drawer button itself sits. */
export const DRAWER_BUTTON_LEFT = "left-3.5 top-[15px]";
export const DRAWER_BUTTON_RIGHT = "right-3.5 top-[15px]";

/** Where the unread badge hangs off the button's outer corner. */
export const DRAWER_BADGE = "-right-1 -top-1";

/** The leading row a page header keeps clear for it. */
export const DRAWER_HEADER_LEFT = "max-md:min-h-[60px] max-md:pl-13";
export const DRAWER_HEADER_RIGHT = "max-md:min-h-[60px] max-md:pr-13";
