import { Type, type Static } from "typebox";

/** The gateway only knows the Plumberr api + internal token; GitHub creds live in the api alone. */
export const ConfigSchema = Type.Object({
  apiBaseUrl: Type.String({ description: "Plumberr api base URL (apps/api)." }),
  apiToken: Type.String({ description: "PLUMBERR_INTERNAL_TOKEN for /internal/* on the api." }),
});
export type Config = Static<typeof ConfigSchema>;
