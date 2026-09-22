import { Program } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";

import idl from "./idl/conduit.json";
import type { Conduit } from "./idl/conduit";

/**
 * A program client held only for its coders.
 *
 * Accounts, instructions and events all need decoding somewhere, and all three
 * decoders have the same requirement: the IDL, converted the way Anchor
 * converts it.
 *
 * Building the coders straight from the JSON IDL was the obvious thing and it
 * is wrong in a way that does not announce itself. The JSON IDL is snake_case
 * and the raw coders take it literally, so an account decodes with keys nobody
 * reads and an instruction encodes a field it does not recognise as zero, with
 * a matching length and discriminator. `Program` converts the IDL to camelCase
 * first, which is why `program.account.mandate.fetch` returns `createdAt`
 * everywhere else in this project. Anchor keeps that conversion internal and
 * exports no way to apply it.
 *
 * So the coders come from here, and the project has one naming convention
 * rather than two that differ by which helper a file happened to reach for.
 *
 * The connection is never used. Decoding is a pure function of the layout and
 * the bytes, and constructing a `Connection` opens no socket. Callers that need
 * to talk to a cluster pass their own.
 */
export const codecProgram = new Program<Conduit>(idl as Conduit, {
  connection: new Connection("http://localhost"),
});
