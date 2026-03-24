# Google Sheets Backend Setup

1. Create a new Google Sheet. This spreadsheet will be your database.
2. Open `Extensions -> Apps Script`.
3. Replace the default script with the contents of [`Code.gs`](./Code.gs).
4. Save the project.
5. Run `initializeDatabase()` once from the Apps Script editor.
6. Review the created sheets:
   - `Users`
   - `Products`
   - `Stock_Balance`
   - `Settings`
   - `POS_Sales`
   - `POS_Sale_Items`
   - `Payments`
7. Deploy the script:
   - `Deploy -> New deployment`
   - Type: `Web app`
   - Execute as: `Me`
   - Who has access: `Anyone`
8. Copy the web app URL.
9. Update [`frontend/config.js`](../../frontend/config.js):
   - set `DATA_MODE` to `"backend"`
   - paste the deployment URL into `APPS_SCRIPT_URL`

## Supported Actions

- `GET ?action=health`
- `GET ?action=products`
- `GET ?action=dashboard`
- `GET ?action=saleReceipt&saleId=SALE-0001`
- `POST { action: "sale", payload: {...} }`

## Notes

- The script is designed to be bound to the Google Sheet so the active spreadsheet becomes the database.
- The frontend currently uses only the sale-related backend actions.
- If you redeploy the Apps Script, update the web app URL in [`frontend/config.js`](../../frontend/config.js) if Google gives you a new one.
