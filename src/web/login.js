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

  function showError(message) {
    errorDiv.textContent = message;
    errorDiv.classList.remove("shake");
    void errorDiv.offsetWidth;
    errorDiv.classList.add("shake");
  }

  function clearError() {
    errorDiv.textContent = "";
    errorDiv.classList.remove("shake");
  }

  keyInput.addEventListener("input", clearError);

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    clearError();
    const apiKey = keyInput.value.trim();

    if (!apiKey) {
      showError("API key is required.");
      keyInput.focus();
      return;
    }

    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = "Signing in…";
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
      showError(data.error || "Authentication failed.");
      keyInput.focus();
    } catch (err) {
      showError("Network error. Please try again.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
})();
