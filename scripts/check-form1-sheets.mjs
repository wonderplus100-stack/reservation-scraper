import "dotenv/config";
import { google } from "googleapis";

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth });

const meta = await sheets.spreadsheets.get({
  spreadsheetId: process.env.FORM_1_SPREADSHEET_ID,
  fields: "sheets.properties.title"
});
console.log((meta.data.sheets || []).map((s) => s.properties.title));
