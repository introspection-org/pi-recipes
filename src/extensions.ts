import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export interface RecipeExtensionSessionContext {
  readonly recipe: {
    readonly name: string;
  };
  readonly agent: {
    readonly name: string;
  };
  readonly session: {
    readonly role: "root" | "subagent";
  };
}

// Embedded hosts may bundle Recipes while extensions resolve their own copy.
// A process-wide symbol keeps their context registry shared across instances.
const recipeExtensionContextsKey = Symbol.for(
  "@introspection-ai/recipes.extension-contexts.v1"
);

function sharedRecipeExtensionContexts(): WeakMap<
  ExtensionAPI,
  RecipeExtensionSessionContext
> {
  const shared = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = shared[recipeExtensionContextsKey];
  if (existing !== undefined) {
    if (!(existing instanceof WeakMap)) {
      throw new Error("The shared Recipe extension context registry is invalid");
    }
    return existing as WeakMap<ExtensionAPI, RecipeExtensionSessionContext>;
  }

  const contexts = new WeakMap<
    ExtensionAPI,
    RecipeExtensionSessionContext
  >();
  Object.defineProperty(shared, recipeExtensionContextsKey, {
    configurable: false,
    enumerable: false,
    value: contexts,
    writable: false,
  });
  return contexts;
}

const contexts = sharedRecipeExtensionContexts();

/** A disposer that threw while unwinding an extension's registrations. */
export interface RecipeExtensionUnwindFailure {
  readonly owner: string;
  readonly error: string;
}

/**
 * One extension's live registration scope. A scope is created per load, so
 * guards captured by a previous load stay disposed even after the same
 * extension path is loaded again.
 *
 * @internal
 */
export interface RecipeExtensionOwnerScope {
  readonly owner: string;
  /** True once this load's registrations have been unwound. */
  readonly disposed: boolean;
  /** Record an undo closure for something this load installed on the host. */
  effect(dispose: () => void | Promise<void>): void;
}

export interface RecipeExtensionRegistrationRegistry {
  claim(kind: string, name: string, owner: string): void;
  release(kind: string, name: string, owner: string): void;
  /**
   * Drop every claim `owner` holds. Claims standing in for what the host
   * itself registered are derived from the host's live registries, so they
   * are rebuilt on each load rather than carried across one.
   */
  releaseOwner(owner: string): void;
  /** @internal Begin a fresh load scope for `owner`. */
  beginOwner(owner: string): RecipeExtensionOwnerScope;
  /**
   * Unwind the named owners, most recently loaded first, releasing their
   * claims so the same paths can be loaded again. Never throws: a disposer
   * that fails is reported so the caller can surface a leaked registration.
   *
   * Pass `hostDiscarded` when the host tore down its own registries, as it
   * does when it rebuilds its runtime. Every recorded disposer and vacated
   * name identifies a registration by name alone, and the host may already
   * have installed something else under that name, so a teardown drops this
   * bookkeeping instead of replaying it against the new runtime.
   */
  unwind(
    owners: readonly string[],
    hostDiscarded?: boolean
  ): Promise<RecipeExtensionUnwindFailure[]>;
  /**
   * True when an unwound extension left this registration behind in the host.
   * Pi keeps tools, commands, and shortcuts for the life of its runtime, so a
   * caller enumerating the host's registrations must not mistake a neutralized
   * one for a host-owned name and block the reload that would replace it.
   */
  vacated(kind: string, name: string): boolean;
  /**
   * Forget every vacated name. A vacancy describes what this registry left
   * behind in one host runtime, so a host that rebuilds its registries voids
   * all of them at once — including any recorded by a load that failed and so
   * left no owner to unwind.
   */
  clearVacated(): void;
}

/** @internal Exact tool names a package extension may keep model-visible. */
export function recipeExtensionToolAllowlist(
  declaredTools: readonly string[],
  hasAgentTool: boolean,
  additionalToolNames: readonly string[] = []
): ReadonlySet<string> {
  return new Set([
    ...declaredTools,
    ...(hasAgentTool ? ["agent"] : []),
    ...additionalToolNames,
  ]);
}

interface OwnerScopeState extends RecipeExtensionOwnerScope {
  disposed: boolean;
  readonly disposers: Array<() => void | Promise<void>>;
}

/**
 * @internal Reject ambiguous registrations across the package closure, and
 * hold the undo closures that let a closure be unwound again.
 */
export function createRecipeExtensionRegistrationRegistry(): RecipeExtensionRegistrationRegistry {
  const owners = new Map<string, string>();
  const scopes = new Map<string, OwnerScopeState>();
  const vacated = new Set<string>();
  return {
    claim(kind, name, owner) {
      const key = `${kind}\0${name}`;
      const existing = owners.get(key);
      if (existing === owner) return;
      if (existing) {
        throw new Error(
          `Recipe extension ${kind} registration "${name}" conflicts between ${existing} and ${owner}`
        );
      }
      owners.set(key, owner);
      vacated.delete(key);
    },
    vacated(kind, name) {
      return vacated.has(`${kind}\0${name}`);
    },
    releaseOwner(owner) {
      for (const [key, holder] of [...owners]) {
        if (holder === owner) owners.delete(key);
      }
    },
    clearVacated() {
      vacated.clear();
    },
    release(kind, name, owner) {
      const key = `${kind}\0${name}`;
      const existing = owners.get(key);
      if (existing !== owner) {
        throw new Error(
          `Recipe extension ${owner} cannot unregister ${kind} "${name}" owned by ${existing ?? "<host>"}`
        );
      }
      owners.delete(key);
    },
    beginOwner(owner) {
      const scope: OwnerScopeState = {
        owner,
        disposed: false,
        disposers: [],
        effect(dispose) {
          // A disposer recorded after unwinding belongs to a registration the
          // host accepted too late to matter; run it immediately rather than
          // retaining it against a scope that will never be unwound again.
          if (scope.disposed) {
            void dispose();
            return;
          }
          scope.disposers.push(dispose);
        },
      };
      scopes.set(owner, scope);
      return scope;
    },
    async unwind(ownersToUnwind, hostDiscarded = false) {
      const failures: RecipeExtensionUnwindFailure[] = [];
      for (const owner of [...ownersToUnwind].reverse()) {
        const scope = scopes.get(owner);
        if (scope) {
          // Mark first: a disposer that triggers host callbacks must not see
          // this extension's guarded handlers as live.
          scope.disposed = true;
          scopes.delete(owner);
          if (!hostDiscarded) {
            for (const dispose of [...scope.disposers].reverse()) {
              try {
                await dispose();
              } catch (error) {
                failures.push({
                  owner,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
          scope.disposers.length = 0;
        }
        for (const [key, holder] of [...owners]) {
          if (holder !== owner) continue;
          owners.delete(key);
          // A name is only worth marking while the host still carries the
          // registration behind it. After a teardown the next thing under that
          // name belongs to whoever registered it, and must be claimed.
          if (!hostDiscarded) vacated.add(key);
        }
      }
      return failures;
    },
  };
}

/** Return the immutable Recipe identity bound to this extension instance. */
export function getRecipeSessionContext(
  pi: ExtensionAPI
): RecipeExtensionSessionContext {
  const context = contexts.get(pi);
  if (!context) {
    throw new Error(
      "This extension is not running inside a Recipe-owned session"
    );
  }
  return context;
}

/** Register behavior only when this session is running the named agent. */
export function forAgent(
  pi: ExtensionAPI,
  agentName: string,
  register: (context: RecipeExtensionSessionContext) => void
): void {
  const context = getRecipeSessionContext(pi);
  if (context.agent.name === agentName) register(context);
}

/** Register behavior only when a session predicate matches. */
export function forRecipeSession(
  pi: ExtensionAPI,
  predicate: (context: RecipeExtensionSessionContext) => boolean,
  register: (context: RecipeExtensionSessionContext) => void
): void {
  const context = getRecipeSessionContext(pi);
  if (predicate(context)) register(context);
}

/** Carries the callable a guard wraps, so re-guarding never stacks. */
const guardedCallable = Symbol.for(
  "@introspection-ai/recipes.guarded-callable.v1"
);

/**
 * Pi can unregister a provider but nothing else, so a disposed extension's
 * entry points are neutralized in place: the registration stays in the host
 * registry and refuses to run. Returns the arguments to install.
 */
function guardRegistration(
  property: string,
  args: readonly unknown[],
  scope: RecipeExtensionOwnerScope
): unknown[] {
  const guard = (
    payload: unknown,
    key: "execute" | "handler",
    kind: string,
    name: string
  ): unknown => {
    const source = payload as Record<string, unknown> | undefined;
    const registered = source?.[key];
    if (typeof registered !== "function") return payload;
    // Guarding edits the payload, and a payload can outlive the load that
    // registered it — a singleton exported by a cached dependency, say. What
    // it carries then is the previous load's guard, which is already disposed,
    // so guard the callable underneath rather than stacking on a dead one.
    const underlying = ((registered as unknown as Record<symbol, unknown>)[
      guardedCallable
    ] ?? registered) as (...callArgs: unknown[]) => unknown;
    const call = underlying.bind(source);
    const guarded = (...callArgs: unknown[]) => {
      if (!scope.disposed) return call(...callArgs);
      throw new Error(
        `Recipe extension ${scope.owner} was unloaded; its ${kind} "${name}" is no longer available`
      );
    };
    Object.defineProperty(guarded, guardedCallable, {
      configurable: true,
      enumerable: false,
      value: underlying,
      writable: false,
    });
    const existing = Object.getOwnPropertyDescriptor(source as object, key);
    const replacement: PropertyDescriptor = {
      configurable: true,
      enumerable: existing?.enumerable ?? true,
      writable: true,
      value: guarded,
    };
    try {
      // Replace the entry point on the payload itself so it keeps its
      // identity. A class instance reading private state through an inherited
      // accessor has to stay the object its own prototype was written for, and
      // no copy carries the private slots that accessor needs.
      Object.defineProperty(source as object, key, replacement);
      return source;
    } catch {
      // Frozen or sealed, so the payload itself cannot be modified.
    }

    // Copying is the only way left to install the guard, and a copy is a
    // different object. Anything whose behavior depends on which object it
    // runs against reads the wrong one: a prototype method reaching a private
    // slot the copy has no way to hold, an accessor keyed by its receiver.
    // Only plain data survives being copied, so refuse the rest here rather
    // than register something that misbehaves at a later call site.
    const prototype = Object.getPrototypeOf(source as object);
    const descriptors = Object.getOwnPropertyDescriptors(source as object);
    const behavesByIdentity =
      (prototype !== Object.prototype && prototype !== null) ||
      Reflect.ownKeys(descriptors).some((property) => {
        const descriptor = (
          descriptors as Record<string | symbol, PropertyDescriptor>
        )[property];
        return (
          typeof descriptor.get === "function" ||
          typeof descriptor.set === "function"
        );
      });
    if (behavesByIdentity) {
      throw new Error(
        `Recipe extension ${scope.owner} registered a frozen ${kind} "${name}" that is more than plain data. Recipes must be able to neutralize a ${kind} when its extension unloads, which needs either the registration itself or a copy of it, and a copy is not the object a prototype method or an accessor was written against. Register plain data, or leave this registration unfrozen.`
      );
    }

    descriptors[key] = replacement;
    return Object.create(prototype, descriptors);
  };

  if (property === "registerTool") {
    const name = String((args[0] as { name?: unknown } | undefined)?.name);
    return [guard(args[0], "execute", "tool", name), ...args.slice(1)];
  }

  if (property === "registerCommand" || property === "registerShortcut") {
    return [
      args[0],
      guard(
        args[1],
        "handler",
        property === "registerCommand" ? "command" : "shortcut",
        String(args[0])
      ),
      ...args.slice(2),
    ];
  }

  return [...args];
}

/** @internal Bind context before Pi invokes a package extension factory. */
export function bindRecipeExtensionFactory(
  factory: ExtensionFactory,
  context: RecipeExtensionSessionContext,
  registrationRegistry?: RecipeExtensionRegistrationRegistry,
  owner = "<recipe-extension>",
  allowedToolNames?: ReadonlySet<string>
): ExtensionFactory {
  return async (pi) => {
    const scope = registrationRegistry?.beginOwner(owner);
    const registrationKinds: Record<string, string> = {
      registerTool: "tool",
      registerCommand: "command",
      registerShortcut: "shortcut",
      registerFlag: "flag",
      registerMessageRenderer: "message renderer",
      registerEntryRenderer: "entry renderer",
      registerProvider: "provider",
    };
    const guarded = registrationRegistry || allowedToolNames
      ? new Proxy(pi, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            const kind =
              typeof property === "string"
                ? registrationKinds[property]
                : undefined;
            if (!kind || !registrationRegistry || typeof value !== "function") {
              if (
                property === "on" &&
                typeof value === "function" &&
                scope
              ) {
                // Lifecycle subscriptions are the registrations that must go
                // quiet first: a stale handler from an unwound closure would
                // otherwise keep running beside its replacement.
                return (
                  event: string,
                  handler: (...handlerArgs: unknown[]) => unknown
                ) => {
                  const guarded = (...handlerArgs: unknown[]) =>
                    scope.disposed ? undefined : handler(...handlerArgs);
                  const off = value.call(target, event, guarded);
                  if (typeof off === "function") {
                    scope.effect(() => {
                      (off as () => void)();
                    });
                  }
                  return off;
                };
              }
              if (
                property === "setActiveTools" &&
                typeof value === "function" &&
                allowedToolNames
              ) {
                return (names: string[]) => {
                  if (scope?.disposed) {
                    throw new Error(
                      `Recipe extension ${owner} was unloaded; it can no longer choose the active tools`
                    );
                  }
                  const undeclared = names.filter(
                    (name) => !allowedToolNames.has(name)
                  );
                  if (undeclared.length > 0) {
                    throw new Error(
                      `Recipe extension attempted to activate undeclared tool(s): ${undeclared.join(", ")}`
                    );
                  }
                  return value.call(target, names);
                };
              }
              if (
                property === "unregisterProvider" &&
                typeof value === "function" &&
                registrationRegistry
              ) {
                return (name: string | { id?: string }) => {
                  if (scope?.disposed) {
                    // Removal is as owner-blind as registration: the claim and
                    // the host entry both answer to the extension path the
                    // replacement load already holds.
                    throw new Error(
                      `Recipe extension ${owner} was unloaded; it can no longer unregister a provider`
                    );
                  }
                  const providerName =
                    typeof name === "string" ? name : name.id;
                  if (providerName) {
                    registrationRegistry.release(
                      "provider",
                      providerName,
                      owner
                    );
                  }
                  return value.call(target, name);
                };
              }
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (...args: unknown[]) => {
              if (scope?.disposed) {
                // A callback that outlived its load can still reach this API.
                // Its owner path is the one the replacement load claims under,
                // so the registry would read the two as the same owner and let
                // this overwrite the live registration with a disposed guard.
                throw new Error(
                  `Recipe extension ${owner} was unloaded; it can no longer register a ${kind}`
                );
              }
              const registrationName =
                property === "registerTool"
                  ? (args[0] as { name?: unknown } | undefined)?.name
                  : property === "registerProvider" &&
                      typeof args[0] === "object"
                    ? (args[0] as { id?: unknown } | undefined)?.id
                  : args[0];
              if (typeof registrationName === "string") {
                registrationRegistry.claim(
                  kind,
                  property === "registerShortcut"
                    ? registrationName.toLowerCase()
                    : registrationName,
                  owner
                );
              }
              if (!scope) return value.apply(target, args);
              const result = value.apply(
                target,
                guardRegistration(String(property), args, scope)
              );
              if (
                property === "registerProvider" &&
                typeof registrationName === "string"
              ) {
                // The one registration Pi can genuinely remove. Call the host
                // method directly: the registry releases this owner's claims
                // itself once the scope finishes unwinding.
                scope.effect(() => {
                  const unregister = Reflect.get(target, "unregisterProvider");
                  if (typeof unregister === "function") {
                    unregister.call(target, registrationName);
                  }
                });
              }
              return result;
            };
          },
        })
      : pi;
    contexts.set(guarded, context);
    await factory(guarded);
  };
}
