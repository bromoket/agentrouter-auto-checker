(function () {
  // Served under a path mount (e.g. /observatory/). A bookmark without the
  // trailing slash resolves relative assets like ./login.css against the
  // origin root, outside the mount, so the page renders unstyled. Canonicalize
  // any single-segment, extension-less path to the same path with a slash.
  try {
    var path = window.location.pathname;
    var segments = path.split("/").filter(Boolean);
    var last = segments[segments.length - 1] || "";
    if (segments.length === 1 && !path.endsWith("/") && !/\.\w+$/.test(last)) {
      window.location.replace(path + "/" + window.location.search + window.location.hash);
    }
  } catch (error) {
    // A navigation failure must never break page rendering.
  }
})();
