# Layerline setup

Layerline is three files: `index.html` (the editor), `config.js` (your Google keys) and this guide. There's no server to run. You host the files on any static web host, connect a Google Cloud project, and you're live.

Setup takes about 30 minutes, once.

## 1. Put the site online

Pick one. All three are free for a site this size and give you an `https://` address, which Google sign-in requires.

- **Netlify Drop (easiest):** go to app.netlify.com/drop and drag the `layerline` folder onto the page. You get an address like `https://something.netlify.app`. Make a free account so the site doesn't expire, and rename it in Site settings (for example `layerline.netlify.app`).
- **Cloudflare Pages:** dash.cloudflare.com → Workers & Pages → Create → Pages → Upload assets.
- **GitHub Pages:** put the files in a GitHub repository, then Settings → Pages → Deploy from branch.

Write down your site address. You'll need it in step 2. You can add your own domain (like `layerline.app`) later. When you do, add it to the list in step 2c too.

## 2. Create the Google Cloud project

Go to console.cloud.google.com and sign in with the Google account that should own the app.

**a. Create a project**
Top bar → project picker → New project → name it `Layerline` → Create. Make sure it's selected.

**b. Turn on the two APIs**
APIs & Services → Library. Search for and enable:
- Google Drive API
- Google Picker API

**c. Set up Google sign-in**
1. Go to **Google Auth Platform** (some accounts show it as "OAuth consent screen") → Get started.
2. App name: `Layerline`. Support email: your email. Audience: **External**. Contact email: your email. Agree and create.
3. **Data access** → Add or remove scopes → find `.../auth/drive.file` ("See, edit, create, and delete only the specific Google Drive files you use with this app") → Update → Save.
4. **Audience** → Test users → add your own Gmail address and anyone else who'll test it.
5. **Clients** → Create client → Application type **Web application** → Name `Layerline web`.
   - Under **Authorized JavaScript origins**, add your site address from step 1, for example `https://layerline.netlify.app` (no slash at the end).
   - Also add `http://localhost:8080` if you want to test on your own computer.
   - Create, then copy the **Client ID**.

**d. Create the API key (used by the Drive file picker)**
APIs & Services → Credentials → Create credentials → API key. Copy it. Then click the key to restrict it:
- Application restrictions → **Websites** → add `https://layerline.netlify.app/*` (your address) and `http://localhost:8080/*`.
- API restrictions → Restrict key → choose **Google Picker API**. Save.

**e. Find the project number**
Click the gear / "Project settings" in the top bar. Copy the **Project number** (digits only).

## 3. Fill in config.js

Open `config.js` in any text editor and paste the three values:

```js
window.LAYERLINE_CONFIG = {
  googleClientId: '1234567890-abc123.apps.googleusercontent.com',
  googleApiKey: 'AIzaSy...',
  googleAppId: '1234567890'
};
```

Upload the folder to your host again (on Netlify Drop, drag the folder onto your site's Deploys page).

These values are safe to be public. Google only accepts them from the addresses you listed, and every user still has to sign in and approve access themselves.

## 4. Try it

Open your site → **Sign in with Google** → approve. Then:
- **Add from Google Drive** opens Google's file picker. Pick videos, audio or images of any size.
- With **Back up imported files** ticked, every file you import is copied to a `Layerline` folder in your Drive in 8 MB pieces. If your connection drops, the upload continues where it stopped.
- **Save to Drive** (or Ctrl+S) saves the project. **Projects** reopens it on any computer, downloading its media back from Drive.
- After exporting, **Save to Drive** puts the finished video in the same folder.

To test on your own computer first, open a terminal in the folder and run `python3 -m http.server 8080`, then visit `http://localhost:8080`.

## 5. Open it to everyone

While the app is in **Testing** mode, only your test users (up to 100) can sign in, and Google asks them to sign in again about once a week.

When you're ready for the public: Google Auth Platform → Audience → **Publish app**. Layerline only asks for `drive.file`, the most limited Drive permission, so Google doesn't require a security review. Google may still ask you to verify the app's name and logo. For that you need:
- a homepage at your domain that describes Layerline
- a privacy policy page (say what you store: nothing on your servers; files go to the user's own Drive)
- your domain verified in Google Search Console

Until it's verified, users may see an "unverified app" notice they can click through.

## How it works (for a developer)

- Sign-in: Google Identity Services token client, scope `drive.file` only. Layerline can only see files it created or that the user picked in the Picker.
- Uploads: Drive API resumable uploads, 8 MB chunks, retry with backoff, and resume by asking Drive how many bytes arrived.
- Downloads: streamed with progress from `files/{id}?alt=media`.
- Projects: JSON files (`*.layerline.json`) in the `Layerline` folder, tagged with `appProperties.layerline = project`. They store tracks, clips and Drive file IDs for every media file.
- Editing, preview and export all run in the browser. Nothing passes through a Layerline server, because there isn't one.

Known limits: very large files are held in the browser's memory while editing, so a laptop with 8 GB of RAM handles a few GB of footage comfortably but not tens of GB. Exports are real-time (a 3-minute video takes 3 minutes).
