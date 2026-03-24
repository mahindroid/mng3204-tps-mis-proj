# GitHub Pages Structure

This project is now structured so the frontend can be published from the `docs/` folder on GitHub Pages.

## Publish Steps

1. Push this project to GitHub.
2. Open the repository settings.
3. Go to `Pages`.
4. Set the source to:
   - Branch: `main` (or your active branch)
   - Folder: `/docs`
5. Save.

## Folders

- `docs/`: GitHub Pages frontend
- `frontend/`: working source copy of the frontend
- `backend/google-apps-script/`: Google Sheets backend script

## Important

If you make more frontend changes, copy the updated files from `frontend/` into `docs/` before publishing.
