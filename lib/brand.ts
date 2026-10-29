export const APP_NAME = "वार्तालाप";
export const APP_NAME_LATIN = "Vartalap";
export const TAGLINE = "Chats, payments and posts — end-to-end encrypted.";

/** The app mark: a chat bubble with typing dots on a saffron→lotus gradient. */
export function markSvg({ maskable = false } = {}) {
  const inner = `
    <path fill="#fff" d="M184 128h144a72 72 0 0 1 72 72v64a72 72 0 0 1-72 72h-92l-70 52c-8 6-18-1-16-10l10-42a72 72 0 0 1-48-68v-68a72 72 0 0 1 72-72z"/>
    <circle cx="200" cy="232" r="20" fill="#f0573f"/>
    <circle cx="256" cy="232" r="20" fill="#e9447a"/>
    <circle cx="312" cy="232" r="20" fill="#c43c9b"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a1f"/><stop offset=".55" stop-color="#f0573f"/><stop offset="1" stop-color="#c43c9b"/></linearGradient></defs>
  <rect width="512" height="512" rx="${maskable ? 0 : 116}" fill="url(#g)"/>
  ${maskable ? `<g transform="translate(51.2 51.2) scale(.8)">${inner}</g>` : `<g transform="translate(0 14)">${inner}</g>`}
</svg>`;
}
