/*
 * Configuration of the front end. This is the only file you normally need to edit.
 * API_URL: the Apps Script web app address (Deploy -> Manage deployments -> Web app URL), ends with /exec.
 */
window.ZAPISY_CONFIG = {
  API_URL: 'PASTE_EXEC_URL_HERE',
  POLL_SECONDS: 60,            // how often the list refreshes itself while the page is open
  REQUEST_TIMEOUT_SECONDS: 40  // Apps Script can take a few seconds, especially after a pause
};
