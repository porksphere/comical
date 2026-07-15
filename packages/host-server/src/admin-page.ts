/**
 * The browser account console — the owner opens `/admin`, enters the master token once, and can
 * create accounts, see every account's sessions, and revoke a session or delete an account. It's the
 * graphical equivalent of the `comical accounts …` / `comical sessions …` CLI, for people who'd
 * rather not use a terminal.
 *
 * Lives here (imported only by `server.ts`), not in `router.ts`, so the HTML page never lands in the
 * bundle the React Native app embeds. All the actual mutations go through the master-token-guarded
 * JSON routes (`POST /accounts`, `DELETE /sessions/:id`, …); this page is just a client for them, and
 * the master token it was opened with is what authorizes those calls.
 */
import type { AccountInfo } from "./account-provider.ts";

const PAGE_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0;
    min-height: 100vh; display: grid; place-items: start center; background: #f5f5f7; color: #1d1d1f; padding: 24px 0; }
  @media (prefers-color-scheme: dark) { body { background: #000; color: #f5f5f7; } .card { background: #1c1c1e; } }
  .card { background: #fff; border-radius: 18px; padding: 28px; max-width: 460px; width: calc(100% - 32px);
    box-shadow: 0 10px 40px rgba(0,0,0,0.12); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 26px 0 8px; }
  p { font-size: 14px; color: #6e6e73; margin: 6px 0; line-height: 1.5; }
  label { font-size: 13px; color: #6e6e73; display: block; margin-top: 10px; }
  input { font-size: 16px; padding: 10px 12px; border: 1px solid rgba(127,127,127,0.4); border-radius: 10px;
    width: 100%; margin: 4px 0; background: transparent; color: inherit; }
  button, .btn { font-size: 15px; font-weight: 600; padding: 10px 16px; border-radius: 10px; border: none;
    background: #208AEF; color: #fff; cursor: pointer; }
  .full { width: 100%; margin-top: 10px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0;
    border-top: 1px solid rgba(127,127,127,0.18); }
  .row .who { font-size: 14px; } .row .who b { display: block; }
  .muted { font-size: 12px; color: #8e8e93; }
  .danger { background: transparent; color: #d33; border: 1.5px solid #d33; padding: 5px 11px; font-size: 13px; }
  .acct { font-weight: 700; font-size: 15px; margin: 18px 0 2px; display: flex; justify-content: space-between; align-items: center; }
  .err { color: #d33; font-size: 14px; }
`;

const shell = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${PAGE_CSS}</style></head><body><div class="card">${body}</div></body></html>`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The master-token gate (also the wrong-token state). */
export function adminLoginPage(error?: string): string {
  return shell(
    "Comical admin",
    `<h1>Comical accounts</h1>
     <p>Enter this server's token to manage accounts.</p>
     ${error ? `<p class="err">${error}</p>` : ""}
     <form method="get" action="/admin">
       <input type="password" name="token" placeholder="Server token (COMICAL_TOKEN)" autofocus required>
       <button class="full" type="submit">Continue</button>
     </form>`,
  );
}

/** The console: create an account, and manage existing accounts + their sessions. */
export function adminConsolePage(opts: { accounts: AccountInfo[]; token: string }): string {
  const accountsHtml = opts.accounts.length
    ? opts.accounts
        .map(
          (a) => `<div class="acct" data-user="${attr(a.username)}">
            <span>${esc(a.username)}</span>
            <span><button class="danger reset">Reset password</button> <button class="danger del-acct">Delete</button></span>
          </div>
          ${
            a.sessions.length
              ? a.sessions
                  .map(
                    (s) => `<div class="row" data-session="${attr(s.id)}">
                      <span class="who"><b>${esc(s.name)}</b><span class="muted">${
                        s.lastSeenAt ? `last seen ${new Date(s.lastSeenAt).toLocaleString()}` : "never synced"
                      }</span></span>
                      <button class="danger revoke">Revoke</button>
                    </div>`,
                  )
                  .join("")
              : `<p class="muted">No active sessions.</p>`
          }`,
        )
        .join("")
    : `<p class="muted">No accounts yet. Create one above.</p>`;

  return shell(
    "Comical accounts",
    `<h1>Accounts</h1>
     <h2>Create an account</h2>
     <label>Username<input id="new-user" autocapitalize="none" autocomplete="off"></label>
     <label>Password<input id="new-pass" type="password" autocomplete="new-password"></label>
     <button class="full" id="create">Create account</button>
     <p class="err" id="create-err"></p>

     <h2>Existing accounts</h2>
     <div id="accounts">${accountsHtml}</div>

     <script>
       history.replaceState(null, "", "/admin"); // keep the token out of the address bar / history
       var token = ${JSON.stringify(opts.token)};
       var H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
       function reload(){ location.href = "/admin?token=" + encodeURIComponent(token); }

       document.getElementById("create").addEventListener("click", function(){
         var u = document.getElementById("new-user").value.trim();
         var p = document.getElementById("new-pass").value;
         var err = document.getElementById("create-err"); err.textContent = "";
         if (!u || !p) { err.textContent = "Username and password are required."; return; }
         fetch("/accounts", { method: "POST", headers: H, body: JSON.stringify({ username: u, password: p }) })
           .then(function(r){ if (r.status === 201) reload();
             else if (r.status === 409) err.textContent = "That username already exists.";
             else err.textContent = "Couldn't create the account (" + r.status + ")."; })
           .catch(function(){ err.textContent = "Network error."; });
       });

       document.getElementById("accounts").addEventListener("click", function(e){
         var t = e.target;
         if (t.classList.contains("revoke")) {
           var id = t.closest(".row").getAttribute("data-session");
           t.disabled = true;
           fetch("/sessions/" + encodeURIComponent(id), { method: "DELETE", headers: H })
             .then(function(r){ if (r.ok) t.closest(".row").remove(); else t.disabled = false; });
         } else if (t.classList.contains("del-acct")) {
           var u = t.closest(".acct").getAttribute("data-user");
           if (!confirm("Delete account " + u + " and all its sessions?")) return;
           fetch("/accounts/" + encodeURIComponent(u), { method: "DELETE", headers: H }).then(function(r){ if (r.ok) reload(); });
         } else if (t.classList.contains("reset")) {
           var u2 = t.closest(".acct").getAttribute("data-user");
           var np = prompt("New password for " + u2 + " (logs it out everywhere):");
           if (!np) return;
           fetch("/accounts/" + encodeURIComponent(u2) + "/password", { method: "PUT", headers: H, body: JSON.stringify({ password: np }) })
             .then(function(r){ if (r.ok) alert("Password updated."); else alert("Failed (" + r.status + ")."); });
         }
       });
     </script>`,
  );
}
