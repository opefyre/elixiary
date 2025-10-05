(function () {
  const now = new Date();
  const yearEl = document.getElementById('year');
  if (yearEl) {
    yearEl.textContent = now.getFullYear();
  }

  const updatedEl = document.getElementById('updated');
  if (updatedEl) {
    updatedEl.textContent = now.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  const form = document.getElementById('contactForm');
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = encodeURIComponent(document.getElementById('name').value.trim());
      const email = encodeURIComponent(document.getElementById('email').value.trim());
      const message = encodeURIComponent(document.getElementById('message').value.trim());
      const subject = `Elixiary contact from ${name}`;
      const body = `Name: ${name}%0AEmail: ${email}%0A%0A${message}`;
      window.location.href = `mailto:info@opefyre.com?subject=${subject}&body=${body}`;
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => {
        registrations.forEach((registration) => registration.unregister());
      })
      .catch(() => {});
  }
})();
