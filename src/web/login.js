(function () {
  const dashboardBasePath = (() => {
    const path = window.location.pathname;
    if (path.endsWith("/login.html") || path.endsWith("/index.html")) {
      return path.slice(0, path.lastIndexOf("/") + 1);
    }
    return `${path.replace(/\/+$/, "")}/`;
  })();
  const dashboardUrl = function (path) {
    return new URL(`${dashboardBasePath}${path.replace(/^\//, "")}`, window.location.origin).toString();
  };
  const form = document.getElementById("login-form");
  const keyInput = document.getElementById("api-key");
  const submitBtn = document.getElementById("submit-btn");
  const errorDiv = document.getElementById("error");

  if (!form || !keyInput || !submitBtn || !errorDiv) return;

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    errorDiv.textContent = "";
    const apiKey = keyInput.value.trim();
    keyInput.value = "";

    if (!apiKey) {
      errorDiv.textContent = "API key is required.";
      return;
    }

    submitBtn.disabled = true;
    try {
      const res = await fetch(dashboardUrl("api/auth/session"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ apiKey }),
      });

      if (res.ok) {
        window.location.replace(dashboardUrl(""));
        return;
      }

      const data = await res.json().catch(function () {
        return {};
      });
      errorDiv.textContent = data.error || "Authentication failed.";
    } catch (err) {
      errorDiv.textContent = "Network error. Please try again.";
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
