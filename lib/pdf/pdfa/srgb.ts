/**
 * The colour profile every PDF/A file carries: sRGB, as its output intent,
 * so DeviceRGB and DeviceGray colours have a defined meaning (PDF/A 6.2.3).
 *
 * This is "sRGB-v2-magic.icc" from Compact ICC Profiles by Clinton Ingram
 * (https://github.com/saucecontrol/Compact-ICC-Profiles), released to the
 * public domain under CC0 1.0: an ICC version 2 display profile (736 bytes,
 * SHA-256 af4efe28f6d311799865f325ba39184a2e978b113ca74124d60af7de22b105f4)
 * built from the sRGB standard's primaries and curve. Version 2 is what
 * PDF/A-1 asks for, and PDF/A-2 and 3 accept it. Kept here as base64 so it
 * loads with the PDF/A code only.
 */
const SRGB_BASE64 =
  "AAAC4GxjbXMCEAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEA" +
  "AAAA0y1oYW5kk7I0qQ6wIoqY/Zqvo2eJmwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAABfY3BydAAA" +
  "AQwAAAAMd3RwdAAAARgAAAAUclhZWgAAASwAAAAUZ1hZWgAAAUAAAAAUYlhZWgAAAVQAAAAUclRSQwAAAWgAAAF4Z1RSQwAAAWgA" +
  "AAF4YlRSQwAAAWgAAAF4ZGVzYwAAAAAAAAAFc1JHQgAAAAAAAAAAAAAAAHRleHQAAAAAQ0MwAFhZWiAAAAAAAADzVAABAAAAARbJ" +
  "WFlaIAAAAAAAAG+gAAA48gAAA49YWVogAAAAAAAAYpYAALeJAAAY2lhZWiAAAAAAAAAkoAAAD4UAALbEY3VydgAAAAAAAAC2AAAA" +
  "HAA4AFQAcACMAKgAxADhAQABIgFGAW0BlQHBAfACIAJVAosCxAMBAz8DggPGBA4EWQSnBPkFTAWkBf4GXAa+ByEHigf0CGMI1QlJ" +
  "CcMKPwq/C0ILyQxUDOENdA4JDqIPQA/gEIURLRHaEooTPhP2FLIVcRY2Fv0XyhiZGW4aRhsiHAMc5x3QHr0friCkIZ4inCOfJKUl" +
  "sSbAJ9Uo7SoKKyssUS18Lqov3jEWMlIzlDTZNiQ3czjGOiA7fDzfPkU/sEEhQpZEEEWPRxJIm0ooS7tNUU7uUI9SNVPgVZBXRVkA" +
  "Wr5chF5MYBth72PHZaZniWlxa19tUW9KcUZzSnVRd155cXuIfaZ/yIHwhB6GUIiJisWNCY9RkZ+T85ZLmKubDp14n+eiW6TWp1ap" +
  "26xnrvexj7Qqtsy5dLwhvtXBjcRMxxDJ2syrz3/SXNU92CTbEt4E4P7j/OcB6gztHPA081D2c/mb/Mr//w==";

export const SRGB_NAME = "sRGB IEC61966-2.1";

let profile: Uint8Array | null = null;

/** The sRGB profile's bytes. */
export function srgbProfile(): Uint8Array {
  if (!profile) {
    const raw = atob(SRGB_BASE64);
    profile = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  return profile;
}
