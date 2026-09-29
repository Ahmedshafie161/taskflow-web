# Taskflow web

A responsive browser companion for Task Manager. The Sketches page reads and writes the same Cloud Firestore project and `sketchBoards` schema used by the Android app.

## Sketches and Firebase

- Board metadata is read from `sketchBoards`; `parentBoardId` and `hierarchyLevel` build the nested page tree.
- Elements are read from `sketchBoards/{boardId}/elements` using the Android app's `elementJson` records. Legacy `content/elements.elementsJson` is also read.
- New pen strokes use the same element JSON format and update `content/elements.nextElementId`.
- Images stored by the Android importer in `sketchMedia/{key}/chunks` are reassembled and displayed. External image and linked media URLs are shown in the page.
- The global theme preference and the dashboard demo data are local to this browser; only sketches use Firebase at this stage.

`firebase-config.js` contains client-side Firebase settings from the Android project's `google-services.json`. These settings identify the project; they are not credentials. Firestore security rules control all reads and writes. This page does not add authentication, so it can access only what the existing rules allow for an unauthenticated client. Do not make sketch data public to make this page work. If rules require a signed-in user, add an approved sign-in flow and use the registered Web app configuration from Firebase Console.

The Firebase compat SDK is loaded from Google's CDN, so the page needs an internet connection. Open it through GitHub Pages or another HTTPS web server. Opening the HTML directly as `file://` can block remote scripts and Firebase requests.

## Publish

The GitHub Actions workflow in `.github/workflows/pages.yml` publishes this folder to GitHub Pages after Pages is configured to use GitHub Actions.
