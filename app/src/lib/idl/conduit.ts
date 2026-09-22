/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/conduit.json`.
 */
export type Conduit = {
  "address": "6X7wfnLNHQvW94CHPVFdguraojh5uEN3Y1gjfi2pkxVu",
  "metadata": {
    "name": "conduit",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "On chain investment mandate enforcement for tokenized equity portfolios"
  },
  "instructions": [
    {
      "name": "initializeMandate",
      "docs": [
        "Creates a mandate: the constitution a portfolio will operate under.",
        "",
        "Constraints are validated here rather than on first use, so an incoherent",
        "mandate fails immediately at the point the owner can still fix it."
      ],
      "discriminator": [
        7,
        251,
        124,
        114,
        46,
        104,
        193,
        22
      ],
      "accounts": [
        {
          "name": "mandate",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  110,
                  100,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "mandateId"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "mandateId",
          "type": "u64"
        },
        {
          "name": "constraints",
          "type": {
            "defined": {
              "name": "mandateConstraints"
            }
          }
        },
        {
          "name": "allowedAssets",
          "type": {
            "vec": {
              "defined": {
                "name": "allowedAsset"
              }
            }
          }
        },
        {
          "name": "agent",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initializePortfolio",
      "docs": [
        "Opens the portfolio governed by a mandate.",
        "",
        "It starts fully in cash. That is the only allocation guaranteed to satisfy",
        "any well formed mandate, so initialization can never produce a portfolio",
        "that is already in breach."
      ],
      "discriminator": [
        122,
        177,
        206,
        169,
        129,
        85,
        26,
        192
      ],
      "accounts": [
        {
          "name": "mandate"
        },
        {
          "name": "portfolio",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  114,
                  116,
                  102,
                  111,
                  108,
                  105,
                  111
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        },
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "proposeRebalance",
      "docs": [
        "The agent asks to move the portfolio to a new allocation.",
        "",
        "This is the only instruction the agent can call, and it is where the",
        "mandate is enforced. Nothing the agent computed off chain is taken on",
        "trust: the weights are re-checked against the mandate as stored on chain,",
        "and any breach aborts the transaction."
      ],
      "discriminator": [
        11,
        89,
        222,
        191,
        238,
        93,
        94,
        177
      ],
      "accounts": [
        {
          "name": "mandate",
          "docs": [
            "`has_one = agent` is the delegation boundary. Any signer other than the",
            "agent named in the mandate is refused before the proposal is even read."
          ],
          "writable": true
        },
        {
          "name": "portfolio",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  114,
                  116,
                  102,
                  111,
                  108,
                  105,
                  111
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        },
        {
          "name": "agent",
          "signer": true,
          "relations": [
            "mandate"
          ]
        }
      ],
      "args": [
        {
          "name": "proposed",
          "type": {
            "vec": {
              "defined": {
                "name": "proposedPosition"
              }
            }
          }
        }
      ]
    },
    {
      "name": "setMandateStatus",
      "docs": [
        "Owner suspends or resumes the agent, or closes the mandate permanently.",
        "",
        "Restricted to the owner. This is the control that makes delegation safe to",
        "grant in the first place: authority handed to an agent can be withdrawn",
        "without the agent's cooperation."
      ],
      "discriminator": [
        119,
        9,
        167,
        49,
        222,
        249,
        195,
        26
      ],
      "accounts": [
        {
          "name": "mandate",
          "writable": true
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "mandate"
          ]
        }
      ],
      "args": [
        {
          "name": "status",
          "type": {
            "defined": {
              "name": "mandateStatus"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "mandate",
      "discriminator": [
        113,
        216,
        98,
        159,
        185,
        63,
        55,
        18
      ]
    },
    {
      "name": "portfolio",
      "discriminator": [
        94,
        158,
        71,
        245,
        122,
        102,
        110,
        225
      ]
    }
  ],
  "events": [
    {
      "name": "rebalanceExecuted",
      "discriminator": [
        194,
        41,
        129,
        249,
        215,
        226,
        122,
        248
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "mandateNotActive",
      "msg": "Mandate is not active, so it cannot accept proposals"
    },
    {
      "code": 6001,
      "name": "unauthorizedAgent",
      "msg": "Signer is not the agent delegated by this mandate"
    },
    {
      "code": 6002,
      "name": "unauthorizedOwner",
      "msg": "Signer is not the owner of this mandate"
    },
    {
      "code": 6003,
      "name": "tooManyAssets",
      "msg": "Proposal references more assets than the mandate permits"
    },
    {
      "code": 6004,
      "name": "assetNotAllowed",
      "msg": "Proposal references an asset outside the mandate's permitted universe"
    },
    {
      "code": 6005,
      "name": "duplicateAsset",
      "msg": "Proposal references the same asset more than once"
    },
    {
      "code": 6006,
      "name": "positionExceedsMaxSize",
      "msg": "A single position exceeds the mandate's maximum position size"
    },
    {
      "code": 6007,
      "name": "insufficientCashReserve",
      "msg": "Proposal leaves less cash than the mandate's minimum reserve"
    },
    {
      "code": 6008,
      "name": "allocationMustSumToFull",
      "msg": "Allocations and cash must sum to exactly 10000 basis points"
    },
    {
      "code": 6009,
      "name": "turnoverExceeded",
      "msg": "Proposal turnover exceeds the mandate's per rebalance limit"
    },
    {
      "code": 6010,
      "name": "invalidBasisPoints",
      "msg": "A basis point value exceeds 10000"
    },
    {
      "code": 6011,
      "name": "contradictoryConstraints",
      "msg": "Mandate constraints are internally contradictory and can never be satisfied"
    },
    {
      "code": 6012,
      "name": "arithmeticOverflow",
      "msg": "Arithmetic overflow while evaluating the proposal"
    },
    {
      "code": 6013,
      "name": "emptyAssetUniverse",
      "msg": "The mandate's permitted asset universe is empty"
    }
  ],
  "types": [
    {
      "name": "allowedAsset",
      "docs": [
        "One asset the mandate permits the agent to hold.",
        "",
        "Identity is the SPL mint, because that is what actually moves on chain. The",
        "Pyth feed id is carried alongside so valuation cannot be pointed at a",
        "different instrument than the one being held: the binding between \"what I own\"",
        "and \"what price I mark it at\" is fixed when the mandate is created, not chosen",
        "later by whoever submits a proposal."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "mandate",
      "docs": [
        "The constitution.",
        "",
        "This account is the reason the project exists. The agent holds no authority of",
        "its own: it may only submit proposals, and every proposal is re-checked",
        "against this account by the program before anything moves. The agent cannot",
        "edit these limits, cannot withdraw, and cannot replace itself. Those are not",
        "promises made by a model, they are instructions it has no way to reach."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandateId",
            "docs": [
              "Caller supplied discriminator, part of this account's PDA seeds.",
              "",
              "Stored as well as being a seed so a client holding the account can",
              "re-derive its own address without having to remember the id separately.",
              "It also lets one owner run several mandates at once, for example a",
              "conservative one and an aggressive one."
            ],
            "type": "u64"
          },
          {
            "name": "owner",
            "docs": [
              "Sole authority permitted to amend, pause or close this mandate."
            ],
            "type": "pubkey"
          },
          {
            "name": "agent",
            "docs": [
              "Delegated proposer. May propose rebalances and nothing else."
            ],
            "type": "pubkey"
          },
          {
            "name": "constraints",
            "docs": [
              "Limits every proposal is measured against."
            ],
            "type": {
              "defined": {
                "name": "mandateConstraints"
              }
            }
          },
          {
            "name": "allowedAssets",
            "docs": [
              "Universe of assets the agent may hold."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "allowedAsset"
                }
              }
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "mandateStatus"
              }
            }
          },
          {
            "name": "version",
            "docs": [
              "Layout version, so a future migration can tell accounts apart."
            ],
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "rebalanceCount",
            "type": "u64"
          },
          {
            "name": "lastRebalanceAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "mandateConstraints",
      "docs": [
        "The numeric limits a proposal is checked against.",
        "",
        "Separated from the account struct so the checking logic can be unit tested as",
        "a pure function, with no validator, no accounts and no runtime."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxPositionBps",
            "docs": [
              "Largest share any single position may occupy."
            ],
            "type": "u16"
          },
          {
            "name": "minCashBps",
            "docs": [
              "Smallest share that must remain in cash."
            ],
            "type": "u16"
          },
          {
            "name": "maxTurnoverBps",
            "docs": [
              "Largest share of the portfolio that may change hands in one rebalance."
            ],
            "type": "u16"
          },
          {
            "name": "maxAssets",
            "docs": [
              "Largest number of simultaneous positions."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "mandateStatus",
      "docs": [
        "Lifecycle of a mandate."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "paused"
          },
          {
            "name": "closed"
          }
        ]
      }
    },
    {
      "name": "portfolio",
      "docs": [
        "The live allocation operating under a mandate."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandate",
            "docs": [
              "Mandate governing this portfolio. Immutable once set."
            ],
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "positions",
            "type": {
              "vec": {
                "defined": {
                  "name": "position"
                }
              }
            }
          },
          {
            "name": "cashBps",
            "docs": [
              "Share currently held in cash. Positions plus cash always total 10000 bps."
            ],
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "position",
      "docs": [
        "A single holding, expressed as a target share of the portfolio.",
        "",
        "Target weight rather than token amount is stored here on purpose. Weights are",
        "what the mandate constrains and what survives a price move; token amounts are",
        "a settlement detail that belongs with the token accounts themselves."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "targetBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "proposedPosition",
      "docs": [
        "A target weight the agent is asking for."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "targetBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "rebalanceExecuted",
      "docs": [
        "Emitted on every accepted rebalance.",
        "",
        "The client reads these to build the agent activity feed, so the history shown",
        "to the user is reconstructed from chain state rather than from an application",
        "database that could disagree with it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandate",
            "type": "pubkey"
          },
          {
            "name": "portfolio",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "turnoverBps",
            "type": "u16"
          },
          {
            "name": "cashBps",
            "type": "u16"
          },
          {
            "name": "positionCount",
            "type": "u8"
          },
          {
            "name": "sequence",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    }
  ]
};
