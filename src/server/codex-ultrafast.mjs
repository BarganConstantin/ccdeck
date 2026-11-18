// OpenAI's GPT-6.2 introductory Ultrafast rates end on March 1, 2027
// at midnight Pacific time. Keep the historical rate in the usage bucket.
export const ULTRAFAST_INTRO_END = Date.parse("2027-03-01T00:00:00-08:00");
export const ULTRAFAST_INTRO_TIER = "ultrafast-intro";
export const GPT_62 = /^gpt[-_]6[-_.]2[-_](?:astra|sol)\b(?![-_][A-Za-z])/i;
