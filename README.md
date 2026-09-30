# Taskflow web

A responsive browser companion for Task Manager. The Sketches page reads and writes the same Cloud Firestore project and `sketchBoards` schema used by the Android app.

## Sketches and Firebase

- Board metadata is read from `sketchBoards`; `parentBoardId` and `hierarchyLevel` build the nested page tree.
- Elements are read from `sketchBoards/{boardId}/elements` using the Android app's `elementJson` records. Legacy `content/elements.elementsJson` is also read.
- New pen strokes use the same element JSON format and update `content/elements.nextElementId`.
- Images stored by the Android importer in `sketchMedia/{key}/chunks` are reassembled and displayed. External image and linked media URLs are shown in the page.
- The global theme preference and the dashboard demo data are local to this browser; only sketches use Firebase at this stage.

`firebase-config.js` uses the registered Firebase web-app settings. These identify the project; they are not credentials. Firestore security rules control all reads and writes. Private media requires a verified Google sign-in for `ahmed.elmenshawie@gmail.com`; anonymous sign-in is intentionally not used.

In Firebase Console, enable **Google** under **Authentication → Sign-in method**. Add the deployed website domain to **Authentication → Settings → Authorized domains**.

The Firebase compat SDK is loaded from Google's CDN, so the page needs an internet connection. Open it through GitHub Pages or another HTTPS web server. Opening the HTML directly as `file://` prevents the Google sign-in flow and private media requests. Add the deployed site's host (and `localhost` for local development) to Firebase Authentication's authorized domains.

## Private OneNote media

The OneNote archive importer stores private Supabase object locators (`supabase-media://...`) in image elements. The web page requests a short-lived URL from `supabase/functions/sign-sketch-media`; the function verifies a Firebase ID token, requires a verified email in `SKETCH_MEDIA_ALLOWED_EMAILS`, then signs the object URL. The bucket stays private. Configure and deploy the function with:

```sh
supabase secrets set SKETCH_MEDIA_ALLOWED_EMAILS=ahmed.elmenshawie@gmail.com
supabase functions deploy sign-sketch-media
```

Keep **Verify JWT with legacy secret** OFF for this function: it validates Firebase tokens itself, then applies the owner email allowlist.

## Publish

The GitHub Actions workflow in `.github/workflows/pages.yml` publishes this folder to GitHub Pages after Pages is configured to use GitHub Actions.
