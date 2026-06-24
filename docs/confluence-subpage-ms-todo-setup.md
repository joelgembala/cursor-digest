# AutoBrief — Setting up the Microsoft To Do integration

AutoBrief pushes each daily report's action items into a Microsoft To Do list (default: **Daily Cursor Tasks**). It authenticates via the Microsoft identity platform using **device code flow** — no redirect URI to configure, no client secret required for personal Microsoft accounts.

You do this once. Tokens auto-refresh after that as long as AutoBrief runs at least once within 90 days.

---

## Step 1 — Register an app in Azure

1. Go to [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**.
  - If you use a personal Microsoft account (outlook.com / hotmail.com / live.com), go to [entra.microsoft.com](https://entra.microsoft.com) and sign in with that account instead.
2. Fill in the form:
  - **Name:** `AutoBrief` (any name is fine)
  - **Supported account types:**
    - Cisco work account → *Accounts in this organizational directory only*
    - Personal Microsoft account → *Personal Microsoft accounts only*
    - Not sure → *Accounts in any organizational directory and personal Microsoft accounts*
  - **Redirect URI:** leave **blank** — AutoBrief uses device code flow, not a redirect
3. Click **Register**.

---

## Step 2 — Enable public client flows

1. In the new app, go to **Authentication** in the left nav.
2. Scroll to **Advanced settings** → **Allow public client flows** → set to **Yes**.
3. Click **Save**.

> ⚠️ Without this step the device code call fails with `AADSTS7000218` / `invalid_client`.

---

## Step 3 — Grant Microsoft Graph permissions

1. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**.
2. Search for and add both of the following:
  - `Tasks.ReadWrite`
  - `offline_access`
3. Click **Add permissions**.
4. **Cisco tenant only:** if a **Grant admin consent for tenant** button appears, click it. Personal accounts consent at sign-in and don't need this step.

---

## Step 4 — Copy your credentials

1. Go to **Overview**.
2. Copy the **Application (client) ID** → this is your `MS_TODO_CLIENT_ID`.
3. If you chose *single-tenant* in Step 1, also copy the **Directory (tenant) ID** → this is your `MS_TODO_TENANT_ID`. Otherwise leave it blank.

---

## Step 5 — Add credentials to `.env`

Open `.env` in your AutoBrief checkout and set the Microsoft To Do section:

```
MS_TODO_CLIENT_ID=<Application (client) ID from Step 4>

# Only set this if you chose single-tenant in Step 1.
# Leave blank for personal accounts or multi-tenant apps.
MS_TODO_TENANT_ID=

# Leave blank — device code flow does not use a client secret.
MS_TODO_CLIENT_SECRET=
```

Save and close the file.

---

## Step 6 — Run the one-time authorization

From the repo root:

```shell
node digest.mjs --setup-todo
```

You will see output like:

```
[setup] Starting Microsoft To Do authentication...

To sign in, use a web browser to open the page https://microsoft.com/devicelogin
and enter the code ABCD-1234 to authenticate.
```

1. Open [https://microsoft.com/devicelogin](https://microsoft.com/devicelogin) in any browser.
2. Enter the code shown in your terminal.
3. Sign in with the **same Microsoft account that owns your To Do lists** (the one you see in the Microsoft To Do app).
4. Approve the consent screen.

When it succeeds you will see:

```
[setup] Authentication successful. Tokens saved.
[setup] Token file: /Users/<you>/Documents/cursor-reports/.ms-todo-tokens.json
```

---

## Step 7 — Re-run the installer

The `install.sh` script bakes your `.env` values into the launchd plist. If you edited `.env` after the first install, re-run it now:

```shell
./install.sh
```

---

## Step 8 — Verify end-to-end

Run a full daily report:

```shell
node digest.mjs --mode=daily
```

Then open **Microsoft To Do**. You should see a list called **Daily Cursor Tasks** (or whatever `todo.listName` is set to in `config.json`) with today's action items as tasks due tomorrow.

---

## Troubleshooting


| Symptom                                                             | Fix                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Missing environment variable: MS_TODO_CLIENT_ID`                   | `.env` isn't loaded. Re-run `./install.sh` after editing `.env`, or source it in your shell before running `node digest.mjs`.                                                                  |
| `AADSTS7000218` / `invalid_client` on `--setup-todo`                | Step 2 was skipped. Go to **Authentication** → **Allow public client flows** → **Yes**.                                                                                                        |
| `AADSTS65001` / "user or administrator has not consented"           | Step 3 permissions weren't granted, or admin consent wasn't clicked on a Cisco tenant app.                                                                                                     |
| `AADSTS50020` / "User account does not exist in tenant"             | You signed in with a personal account against a single-tenant app (or vice versa). Re-register the app with the correct *Supported account types* in Step 1.                                   |
| `No Microsoft auth tokens found. Run: node digest.mjs --setup-todo` | Token cache was deleted or `config.reports.outputDir` changed. Re-run `node digest.mjs --setup-todo`.                                                                                          |
| `Token refresh failed: invalid_grant`                               | Refresh token expired (>90 days since last run, or password/MFA changed). Re-run `node digest.mjs --setup-todo`.                                                                               |
| Tasks appear in the wrong To Do account                             | You authorized with a different Microsoft account than the one in your To Do app. Delete `~/Documents/cursor-reports/.ms-todo-tokens.json` and re-run `--setup-todo` with the correct account. |


---

The token cache lives at `~/Documents/cursor-reports/.ms-todo-tokens.json`. Deleting that file forces a fresh `--setup-todo` on the next run — useful if you are stuck in a bad auth state.