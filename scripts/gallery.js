// Covers can disappear independently of a cached index. Keep the card usable.
for (const image of document.querySelectorAll('.cover img')) {
  const unavailable = () => {
    image.hidden = true;
    image.previousElementSibling.removeAttribute('aria-hidden');
  };
  image.addEventListener('error', unavailable);
  if (image.complete && image.naturalWidth === 0) unavailable();
}
