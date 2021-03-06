import {
  ApplicationCommandInteractionData,
  ApplicationCommandOption,
  ApplicationCommandOptionType,
  ConnInfo,
  Interaction,
  InteractionResponseType,
  InteractionType,
  PartialApplicationCommand,
  router,
  serve,
  sign,
  Snowflake,
} from "./deps.ts";

const DISCORD_BASE_URL = "https://discord.com/api/v9";

const NAME_REGEX = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

export type Handler = (
  request: Request,
  connInfo: ConnInfo,
  params: Record<string, string>,
) => Response | Promise<Response>;

export class Router {
  #publicKey: Snowflake;
  #applicationId: Snowflake;
  #authToken: string;
  #tokenPrefix: string;
  #guildId: Snowflake;
  #commands: PartialApplicationCommand[];

  constructor(
    options: {
      applicationId?: Snowflake;
      publicKey?: Snowflake;
      authToken?: string;
      tokenPrefix?: string;
      endpoint?: string;
      guildId?: Snowflake;
      serveOnly?: boolean;
    } & Record<string, Handler>,
  ) {
    const {
      applicationId = Deno.env.get("DISCORD_APPLICATION_ID") || "",
      publicKey = Deno.env.get("DISCORD_PUBLIC_KEY") || "",
      authToken = Deno.env.get("DISCORD_BOT_TOKEN") || "",
      tokenPrefix,
      endpoint = "/api/interactions",
      guildId = Deno.env.get("DISCORD_GUILD_ID"),
      serveOnly = false,
      ...userRoutes
    } = options;

    this.#publicKey = publicKey;
    this.#applicationId = applicationId;
    this.#authToken = authToken;
    this.#tokenPrefix = (tokenPrefix || "Bot") + " ";
    this.#guildId = guildId || "";

    const commands = [];

    for (const [route, handler] of Object.entries(userRoutes)) {
      // Ensures the handler's name is the route.
      Object.defineProperty(handler, "name", { value: route });

      const url = new URL(route, "https://example.com");
      // Creates application command from the route.
      const command = this.commandFromUri(url);
      if (command) {
        commands.push(command);
        // Stores the route handler as a property of this instance by command name.
        Object.defineProperty(this, command.name, {
          get() {
            return handler;
          },
        });
      }
    }

    this.#commands = commands;

    // Serves HTTP endpoint for Discord to send payload to.
    serve(router({
      [endpoint]: this.#handleInteraction.bind(this) as Handler,
      ...userRoutes,
    }));

    if (!serveOnly) {
      this.registerApplicationCommands(guildId);
    }
  }

  /**
   * Creates a partial application command from route URL.
   */
  commandFromUri(uri: string | URL): PartialApplicationCommand | null {
    /** @TODO: Uses decorators for description and option type? */
    const { pathname, searchParams } = new URL(
      uri.toString(),
      "https://example.com",
    );
    /** @FIXME: Command name is not always the only one. */
    const [_, name, ...params] = pathname.split("/");

    if (!NAME_REGEX.test(name)) {
      console.error(`Invalid command name: ${name}`);
      return null;
    }

    // Required options must be listed before optional options.
    const options: ApplicationCommandOption[] = [];

    // Params are required options.
    params.forEach((param) => {
      const name = param.substring(1);
      options.push({
        type: ApplicationCommandOptionType.STRING,
        name,
        description: name, /** @FIXME: Actual description */
        required: true,
        choices: undefined,
        // channel_types: undefined,
        options: undefined,
        // min_value: undefined,
        // max_value: undefined,
        // autocomplete: undefined,
      });
    });

    // Search params are optional options.
    searchParams.forEach((_defaultValue, name) => {
      options.push({
        type: ApplicationCommandOptionType.STRING,
        name,
        description: name, /** @FIXME: Actual description */
        required: false,
        choices: undefined,
        // channel_types: undefined,
        options: undefined,
        // min_value: undefined,
        // max_value: undefined,
        // autocomplete: undefined,
      });
    });

    const command: PartialApplicationCommand = {
      name,
      description: name, /** @FIXME: Actual description */
      options,
    };

    return command;
  }

  async registerApplicationCommands(
    guildId: Snowflake = this.#guildId,
  ): Promise<Response> {
    const partials = this.#commands;

    const endpoint = guildId
      ? `applications/${this.#applicationId}/guilds/${guildId}/commands`
      : `applications/${this.#applicationId}/commands`;
    const headers = {
      "Authorization": `${this.#tokenPrefix}${this.#authToken}`,
      "Content-Type": "application/json",
    };

    const response = await fetch(`${DISCORD_BASE_URL}/${endpoint}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(partials),
    });

    return response;
  }

  async #handleInteraction(
    request: Request,
    connInfo: ConnInfo,
  ): Promise<Response> {
    const { error, status, body } = await this.#validate(request);
    if (error) {
      return new Response(
        JSON.stringify({
          error,
        }),
        {
          status,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
        },
      );
    }

    const {
      // id,
      type = 0,
      data: {
        // id,
        name,
        options = [],
      } = {
        id: "",
        name: "",
        options: [],
      } as ApplicationCommandInteractionData,
      // guild_id,
      // channel_id,
      // member = { user: null },
      // user,
      // token,
      // version,
      // message,
      // locale,
      // guild_locale,
    } = JSON.parse(body!) as Interaction;

    // Discord performs Ping interactions to test our application.
    if (type === InteractionType.PING) {
      return new Response(
        JSON.stringify({
          type: InteractionResponseType.PONG,
        }),
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
        },
      );
    }

    if (type === InteractionType.APPLICATION_COMMAND) {
      const reply = {
        // Type 4 responds with the below message retaining the user's
        // input at the top.
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "",
          embeds: [],
          components: [],
          attachments: [],
        },
      };

      // @ts-ignore Instance has this property by command's name.
      const handler = this[name];
      const route = handler.name; // User-defined route, i.e. `/hello/:name?age=`

      const params: Record<string, string> = {};
      const url = new URL(route, request.url);
      const searchParams = url.searchParams;

      /** Starts with optional options first, since we can check against `searchParams`. */
      // @ts-ignore We know `option` has `value`
      options!.forEach(({ name, value }, index) => {
        /** Overrides the searchParam value with provided option value. */
        if (searchParams.has(name)) {
          searchParams.set(name, value);
          /** Removes this option from provided option list. */
          options!.splice(index, 1);
        }
      });

      /** At this point, `options` contains only required params. */
      // @ts-ignore We know `option` has `value`
      options!.forEach(({ name, value }) => {
        params[name] = value; /** Collects here to pass to handler. */
        url.pathname = url.pathname.replace(`:${name}`, value);
      });

      const response = await handler(new Request(url.href), connInfo, params);
      reply.data.content = await response.text();

      return new Response(JSON.stringify(reply), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      });
    }

    // We will return a bad request error as a valid Discord request
    // shouldn't reach here.
    return new Response(
      JSON.stringify({
        error: "bad request",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  }

  /**
   * Verify whether the request is coming from Discord.
   * When the request's signature is not valid, we return a 401 and this is
   * important as Discord sends invalid requests to test our verification.
   */
  async #validate(
    request: Request,
  ): Promise<{ error?: string; status?: number; body?: string }> {
    const signature = request.headers.get("X-Signature-Ed25519")!;
    const timestamp = request.headers.get("X-Signature-Timestamp")!;
    if (!signature) {
      return { error: `header X-Signature-Ed25519 not available`, status: 400 };
    }
    if (!timestamp) {
      return {
        error: `header X-Signature-Timestamp not available`,
        status: 400,
      };
    }

    const body = await request.text();

    const valid = sign.detached.verify(
      new TextEncoder().encode(timestamp + body),
      hexToUint8Array(signature),
      hexToUint8Array(this.#publicKey),
    );

    if (!valid) {
      return { error: "Invalid request", status: 401 };
    }

    return { body };
  }
}

/** Converts a hexadecimal string to Uint8Array. */
function hexToUint8Array(hex: string) {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((val) => parseInt(val, 16)));
}
