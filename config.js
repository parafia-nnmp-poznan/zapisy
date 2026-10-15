/*
 * Configuration of the front end. This is the only file you normally need to edit.
 * API_URL: the Apps Script web app address (Deploy -> Manage deployments -> Web app URL), ends with /exec.
 */
window.ZAPISY_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxvCC7TqwVtZArHkFC82ok07khC5m1552hrXqZdfuMS7m8sNL39SctIf2hEWyrmWeW0/exec',
  POLL_SECONDS: 60,             // how often the list refreshes itself while the page is open
  REQUEST_TIMEOUT_SECONDS: 40,  // Apps Script can take a few seconds, especially after a pause
  RETENTION_DAYS : 7
};
