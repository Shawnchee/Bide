import { createActionHeaders, type ActionsJson } from "@solana/actions";

const headers = createActionHeaders({ chainId: "devnet" });

export const GET = () => {
  const body: ActionsJson = {
    rules: [
      { pathPattern: "/earn**", apiPath: "/api/actions/plan**" },
      { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" },
    ],
  };
  return Response.json(body, { headers });
};

export const OPTIONS = () => new Response(null, { headers });
