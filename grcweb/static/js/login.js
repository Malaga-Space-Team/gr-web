'use strict';

(function () {
  try {
    const theme = localStorage.getItem('grcweb.theme');
    const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) { /* storage unavailable */ }

  const form = document.getElementById('login');
  const error = document.getElementById('error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: form.user.value, password: form.password.value }),
        credentials: 'same-origin',
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        location.replace('/');
        return;
      }
      error.textContent = data.error || 'Sign in failed';
      form.password.select();
    } catch (e) {
      error.textContent = 'Cannot reach the server';
    } finally {
      button.disabled = false;
    }
  });
})();
