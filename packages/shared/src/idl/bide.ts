/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/bide.json`.
 */
export type Bide = {
  "address": "4bwTwLAZqPMLSbdvQQ9UrePJiRBUKgiA8TKV3ydo4tqe",
  "metadata": {
    "name": "bide",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Bide: name your price, get paid until it fills (cash-secured puts / covered calls on Solana)"
  },
  "instructions": [
    {
      "name": "addAsset",
      "discriminator": [
        81,
        53,
        134,
        142,
        243,
        73,
        42,
        179
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "asset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "assetParams"
            }
          }
        }
      ]
    },
    {
      "name": "cancelRound",
      "discriminator": [
        82,
        70,
        134,
        54,
        46,
        96,
        148,
        8
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "plan",
          "writable": true
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "rentPayer",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "closePlan",
      "discriminator": [
        45,
        137,
        184,
        220,
        162,
        253,
        161,
        8
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "owner for close_plan; anyone for expire_plan"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "plan",
          "writable": true
        },
        {
          "name": "lendAuth",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "plan"
              }
            ]
          }
        },
        {
          "name": "vaultCollateral",
          "docs": [
            "ATA(phase collateral mint, lend_auth): Lend withdrawals land here first"
          ],
          "writable": true
        },
        {
          "name": "vaultFToken",
          "docs": [
            "ATA(fToken, lend_auth); None when the collateral has no Lend market"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "ownerCollateral",
          "writable": true
        },
        {
          "name": "vaultAsset",
          "docs": [
            "Wheel-Accumulate only: ATA(asset, lend_auth) holding filled asset"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "ownerAsset",
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "createPlan",
      "discriminator": [
        77,
        43,
        141,
        254,
        212,
        118,
        41,
        186
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "asset",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "asset.mint",
                "account": "asset"
              }
            ]
          }
        },
        {
          "name": "plan",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "args.nonce"
              }
            ]
          }
        },
        {
          "name": "lendAuth",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "plan"
              }
            ]
          }
        },
        {
          "name": "collateralMint",
          "docs": [
            "USDC for Buy/Wheel, asset mint for Sell"
          ]
        },
        {
          "name": "ownerCollateral",
          "writable": true
        },
        {
          "name": "vaultCollateral",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "lendAuth"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "collateralMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultFToken",
          "docs": [
            "ATA(fToken of collateral_mint, lend_auth); None if the collateral has no Lend market"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createPlanArgs"
            }
          }
        }
      ]
    },
    {
      "name": "expirePlan",
      "discriminator": [
        110,
        63,
        52,
        154,
        97,
        199,
        126,
        28
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "owner for close_plan; anyone for expire_plan"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "plan",
          "writable": true
        },
        {
          "name": "lendAuth",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "plan"
              }
            ]
          }
        },
        {
          "name": "vaultCollateral",
          "docs": [
            "ATA(phase collateral mint, lend_auth): Lend withdrawals land here first"
          ],
          "writable": true
        },
        {
          "name": "vaultFToken",
          "docs": [
            "ATA(fToken, lend_auth); None when the collateral has no Lend market"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "ownerCollateral",
          "writable": true
        },
        {
          "name": "vaultAsset",
          "docs": [
            "Wheel-Accumulate only: ATA(asset, lend_auth) holding filled asset"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "ownerAsset",
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "flipPlan",
      "discriminator": [
        247,
        11,
        95,
        18,
        223,
        147,
        237,
        137
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "plan",
          "writable": true
        },
        {
          "name": "lendAuth",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "plan"
              }
            ]
          }
        },
        {
          "name": "vaultUsdc",
          "writable": true
        },
        {
          "name": "vaultUsdcFToken",
          "writable": true
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "vaultAsset",
          "writable": true
        },
        {
          "name": "vaultAssetFToken",
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initConfig",
      "discriminator": [
        23,
        235,
        115,
        232,
        168,
        96,
        1,
        231
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agent",
          "type": "pubkey"
        },
        {
          "name": "feeBps",
          "type": "u16"
        },
        {
          "name": "feeRecipient",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initPool",
      "discriminator": [
        116,
        233,
        199,
        204,
        115,
        159,
        171,
        36
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "poolAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "poolParams"
            }
          }
        }
      ]
    },
    {
      "name": "migratePool",
      "discriminator": [
        55,
        170,
        171,
        123,
        210,
        69,
        39,
        172
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "openEpoch",
      "discriminator": [
        75,
        57,
        218,
        33,
        173,
        254,
        207,
        136
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "asset",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "asset.mint",
                "account": "asset"
              }
            ]
          }
        },
        {
          "name": "epoch",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "kind",
          "type": {
            "defined": {
              "name": "epochKind"
            }
          }
        },
        {
          "name": "expiry",
          "type": "i64"
        }
      ]
    },
    {
      "name": "openRound",
      "discriminator": [
        66,
        235,
        123,
        240,
        8,
        35,
        185,
        159
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "asset",
          "relations": [
            "epoch"
          ]
        },
        {
          "name": "plan",
          "writable": true
        },
        {
          "name": "epoch"
        },
        {
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "plan"
              },
              {
                "kind": "arg",
                "path": "args.round_index"
              }
            ]
          }
        },
        {
          "name": "escrowMint",
          "docs": [
            "asset mint for a Put, USDC for a Call"
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "spotFeed"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "openRoundArgs"
            }
          }
        }
      ]
    },
    {
      "name": "pausePlan",
      "discriminator": [
        208,
        200,
        160,
        171,
        212,
        94,
        249,
        233
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "plan"
          ]
        },
        {
          "name": "plan",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "poolDeposit",
      "discriminator": [
        26,
        109,
        164,
        79,
        207,
        145,
        204,
        217
      ],
      "accounts": [
        {
          "name": "lp",
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "poolAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true
        },
        {
          "name": "lpShares",
          "writable": true
        },
        {
          "name": "mint",
          "docs": [
            "USDC or WSOL"
          ]
        },
        {
          "name": "lpSource",
          "writable": true
        },
        {
          "name": "poolUsdc",
          "writable": true
        },
        {
          "name": "poolWsol",
          "writable": true
        },
        {
          "name": "solAsset",
          "docs": [
            "SOL asset (spot feed params)"
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "const",
                "value": [
                  6,
                  155,
                  136,
                  87,
                  254,
                  171,
                  129,
                  132,
                  251,
                  104,
                  127,
                  99,
                  70,
                  24,
                  192,
                  53,
                  218,
                  196,
                  57,
                  220,
                  26,
                  235,
                  59,
                  85,
                  152,
                  160,
                  240,
                  0,
                  0,
                  0,
                  0,
                  1
                ]
              }
            ]
          }
        },
        {
          "name": "spotFeed"
        },
        {
          "name": "lendingUsdc",
          "address": "98Uy7eonumvRbhQvP5Jt7B3WjNqpndioMF99xvR7sDVa"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "poolLendIdle",
      "discriminator": [
        121,
        73,
        195,
        86,
        82,
        162,
        228,
        20
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "poolAuth",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "poolUsdc",
          "writable": true
        },
        {
          "name": "poolFToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "poolTakeRound",
      "discriminator": [
        88,
        79,
        247,
        109,
        178,
        237,
        83,
        44
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "asset"
        },
        {
          "name": "plan"
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "epoch"
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "spotFeed"
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "poolAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "poolUsdc",
          "writable": true
        },
        {
          "name": "poolWsol",
          "writable": true
        },
        {
          "name": "lendingUsdc",
          "address": "98Uy7eonumvRbhQvP5Jt7B3WjNqpndioMF99xvR7sDVa"
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "feeUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "poolUnlend",
      "discriminator": [
        128,
        80,
        116,
        108,
        125,
        203,
        72,
        136
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "poolAuth",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "poolUsdc",
          "writable": true
        },
        {
          "name": "poolFToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "poolWithdraw",
      "discriminator": [
        50,
        1,
        23,
        25,
        135,
        221,
        159,
        182
      ],
      "accounts": [
        {
          "name": "lp",
          "writable": true,
          "signer": true
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "poolAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "pool"
              }
            ]
          }
        },
        {
          "name": "shareMint",
          "writable": true
        },
        {
          "name": "lpShares",
          "writable": true
        },
        {
          "name": "poolUsdc",
          "writable": true
        },
        {
          "name": "poolWsol",
          "writable": true
        },
        {
          "name": "poolFToken",
          "writable": true
        },
        {
          "name": "lpUsdc",
          "writable": true
        },
        {
          "name": "lpWsol",
          "writable": true
        },
        {
          "name": "lpFToken",
          "writable": true
        },
        {
          "name": "solAsset",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "const",
                "value": [
                  6,
                  155,
                  136,
                  87,
                  254,
                  171,
                  129,
                  132,
                  251,
                  104,
                  127,
                  99,
                  70,
                  24,
                  192,
                  53,
                  218,
                  196,
                  57,
                  220,
                  26,
                  235,
                  59,
                  85,
                  152,
                  160,
                  240,
                  0,
                  0,
                  0,
                  0,
                  1
                ]
              }
            ]
          }
        },
        {
          "name": "spotFeed"
        },
        {
          "name": "lendingUsdc",
          "address": "98Uy7eonumvRbhQvP5Jt7B3WjNqpndioMF99xvR7sDVa"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u64"
        }
      ]
    },
    {
      "name": "postSample",
      "discriminator": [
        98,
        100,
        231,
        60,
        159,
        134,
        86,
        185
      ],
      "accounts": [
        {
          "name": "asset"
        },
        {
          "name": "epoch",
          "writable": true
        },
        {
          "name": "priceUpdate"
        }
      ],
      "args": [
        {
          "name": "bucket",
          "type": "u8"
        }
      ]
    },
    {
      "name": "resolveEpoch",
      "discriminator": [
        127,
        233,
        72,
        190,
        252,
        134,
        239,
        218
      ],
      "accounts": [
        {
          "name": "epoch",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "resolveRound",
      "discriminator": [
        165,
        114,
        237,
        158,
        1,
        36,
        70,
        254
      ],
      "accounts": [
        {
          "name": "plan",
          "writable": true
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "epoch"
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "userDest",
          "docs": [
            "Call: owner's USDC account. Validated."
          ],
          "writable": true
        },
        {
          "name": "makerDest",
          "writable": true
        },
        {
          "name": "rentPayer",
          "writable": true
        },
        {
          "name": "pool",
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "rotateAgent",
      "discriminator": [
        182,
        91,
        147,
        107,
        155,
        47,
        150,
        176
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newAgent",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setFee",
      "discriminator": [
        18,
        154,
        24,
        18,
        237,
        214,
        19,
        80
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "feeBps",
          "type": "u16"
        },
        {
          "name": "feeRecipient",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setPaused",
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setPoolParams",
      "discriminator": [
        155,
        57,
        152,
        27,
        154,
        140,
        166,
        126
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "pool"
          ]
        },
        {
          "name": "pool",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        },
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "poolParams"
            }
          }
        }
      ]
    },
    {
      "name": "takeRound",
      "discriminator": [
        223,
        89,
        169,
        145,
        212,
        41,
        16,
        10
      ],
      "accounts": [
        {
          "name": "maker",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "asset"
        },
        {
          "name": "plan"
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "spotFeed"
        },
        {
          "name": "makerUsdc",
          "writable": true
        },
        {
          "name": "makerAsset",
          "writable": true,
          "optional": true
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "feeUsdc",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "unwindRound",
      "discriminator": [
        162,
        140,
        115,
        156,
        54,
        58,
        171,
        200
      ],
      "accounts": [
        {
          "name": "plan",
          "writable": true
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "epoch"
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "round"
              }
            ]
          }
        },
        {
          "name": "makerDest",
          "writable": true
        },
        {
          "name": "rentPayer",
          "writable": true
        },
        {
          "name": "pool",
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "updateAsset",
      "discriminator": [
        56,
        126,
        238,
        138,
        192,
        118,
        228,
        172
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "asset",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "asset.mint",
                "account": "asset"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "assetParams"
            }
          }
        }
      ]
    },
    {
      "name": "updatePlan",
      "discriminator": [
        119,
        112,
        58,
        60,
        76,
        205,
        1,
        100
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "plan"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "asset"
        },
        {
          "name": "plan",
          "writable": true
        },
        {
          "name": "lendAuth",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "plan"
              }
            ]
          }
        },
        {
          "name": "ownerCollateral",
          "writable": true
        },
        {
          "name": "vaultCollateral",
          "writable": true
        },
        {
          "name": "vaultFToken",
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "updatePlanArgs"
            }
          }
        }
      ]
    },
    {
      "name": "withdrawCollateral",
      "discriminator": [
        115,
        135,
        168,
        106,
        139,
        214,
        138,
        150
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "plan",
          "writable": true
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "lendAuth",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  110,
                  100,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "plan"
              }
            ]
          }
        },
        {
          "name": "vaultStaging",
          "docs": [
            "ATA(USDC (Put) | asset (Call), lend_auth)"
          ],
          "writable": true
        },
        {
          "name": "vaultFToken",
          "writable": true,
          "optional": true
        },
        {
          "name": "counterpartyDest",
          "writable": true
        },
        {
          "name": "rentPayer",
          "writable": true
        },
        {
          "name": "pool",
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  111,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "asset",
      "discriminator": [
        234,
        180,
        241,
        252,
        139,
        224,
        160,
        8
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "epoch",
      "discriminator": [
        93,
        83,
        120,
        89,
        151,
        138,
        152,
        108
      ]
    },
    {
      "name": "plan",
      "discriminator": [
        161,
        231,
        251,
        119,
        2,
        12,
        162,
        2
      ]
    },
    {
      "name": "pool",
      "discriminator": [
        241,
        154,
        109,
        4,
        17,
        177,
        109,
        188
      ]
    },
    {
      "name": "round",
      "discriminator": [
        87,
        127,
        165,
        51,
        73,
        78,
        116,
        174
      ]
    }
  ],
  "events": [
    {
      "name": "collateralWithdrawn",
      "discriminator": [
        51,
        224,
        133,
        106,
        74,
        173,
        72,
        82
      ]
    },
    {
      "name": "epochFailed",
      "discriminator": [
        89,
        162,
        134,
        101,
        119,
        50,
        195,
        138
      ]
    },
    {
      "name": "epochOpened",
      "discriminator": [
        136,
        166,
        130,
        170,
        78,
        145,
        67,
        78
      ]
    },
    {
      "name": "epochResolved",
      "discriminator": [
        62,
        81,
        212,
        223,
        209,
        104,
        51,
        65
      ]
    },
    {
      "name": "planClosed",
      "discriminator": [
        244,
        135,
        44,
        167,
        104,
        238,
        207,
        12
      ]
    },
    {
      "name": "planCreated",
      "discriminator": [
        215,
        11,
        135,
        121,
        208,
        119,
        149,
        149
      ]
    },
    {
      "name": "planExpired",
      "discriminator": [
        219,
        217,
        22,
        45,
        232,
        107,
        101,
        47
      ]
    },
    {
      "name": "planFlipped",
      "discriminator": [
        35,
        132,
        254,
        28,
        123,
        139,
        198,
        25
      ]
    },
    {
      "name": "planUpdated",
      "discriminator": [
        49,
        51,
        198,
        31,
        170,
        70,
        253,
        195
      ]
    },
    {
      "name": "poolDeposited",
      "discriminator": [
        148,
        17,
        86,
        50,
        113,
        125,
        70,
        132
      ]
    },
    {
      "name": "poolWithdrawn",
      "discriminator": [
        23,
        62,
        221,
        23,
        53,
        222,
        69,
        207
      ]
    },
    {
      "name": "roundCancelled",
      "discriminator": [
        238,
        141,
        105,
        175,
        182,
        158,
        15,
        7
      ]
    },
    {
      "name": "roundOpened",
      "discriminator": [
        99,
        173,
        228,
        72,
        142,
        57,
        109,
        178
      ]
    },
    {
      "name": "roundResolved",
      "discriminator": [
        204,
        146,
        253,
        187,
        8,
        61,
        75,
        29
      ]
    },
    {
      "name": "roundTaken",
      "discriminator": [
        111,
        17,
        126,
        135,
        228,
        253,
        241,
        40
      ]
    },
    {
      "name": "roundUnwound",
      "discriminator": [
        121,
        51,
        50,
        51,
        244,
        185,
        4,
        248
      ]
    },
    {
      "name": "samplePosted",
      "discriminator": [
        229,
        25,
        221,
        234,
        235,
        189,
        164,
        56
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "epochNotOpen",
      "msg": "Epoch is not open"
    },
    {
      "code": 6001,
      "name": "outsideAuctionWindow",
      "msg": "Outside the auction window for this epoch kind"
    },
    {
      "code": 6002,
      "name": "epochNotResolved",
      "msg": "Epoch is not resolved"
    },
    {
      "code": 6003,
      "name": "graceNotElapsed",
      "msg": "Grace period has not elapsed"
    },
    {
      "code": 6004,
      "name": "planNotExpired",
      "msg": "Plan has not expired"
    },
    {
      "code": 6005,
      "name": "paused",
      "msg": "Protocol is paused"
    },
    {
      "code": 6006,
      "name": "planPaused",
      "msg": "Plan is paused"
    },
    {
      "code": 6007,
      "name": "assetDisabled",
      "msg": "Asset is disabled"
    },
    {
      "code": 6008,
      "name": "strikeOutOfBounds",
      "msg": "Strike outside the user's bounds"
    },
    {
      "code": 6009,
      "name": "strikeOffTick",
      "msg": "Strike is not on the asset tick"
    },
    {
      "code": 6010,
      "name": "sizeTooLarge",
      "msg": "Size exceeds the plan's remaining size"
    },
    {
      "code": 6011,
      "name": "expiryOutOfBounds",
      "msg": "Expiry outside the user's bounds"
    },
    {
      "code": 6012,
      "name": "rateLimited",
      "msg": "Round rate limit reached"
    },
    {
      "code": 6013,
      "name": "premiumBelowUserMin",
      "msg": "Premium below the user's signed minimum (after fee)"
    },
    {
      "code": 6014,
      "name": "auctionParamsInvalid",
      "msg": "Invalid auction parameters"
    },
    {
      "code": 6015,
      "name": "activeRoundExists",
      "msg": "Plan already has an active round"
    },
    {
      "code": 6016,
      "name": "wrongStatus",
      "msg": "Wrong status for this action"
    },
    {
      "code": 6017,
      "name": "auctionOver",
      "msg": "Auction is over"
    },
    {
      "code": 6018,
      "name": "poolWindowNotReached",
      "msg": "Pool window not reached"
    },
    {
      "code": 6019,
      "name": "spotMovedTooMuch",
      "msg": "Spot moved too much since the auction opened"
    },
    {
      "code": 6020,
      "name": "stalePrice",
      "msg": "Price is stale"
    },
    {
      "code": 6021,
      "name": "priceConfidenceTooWide",
      "msg": "Price confidence too wide"
    },
    {
      "code": 6022,
      "name": "wrongFeed",
      "msg": "Wrong price feed"
    },
    {
      "code": 6023,
      "name": "bucketOutOfRange",
      "msg": "Bucket out of range"
    },
    {
      "code": 6024,
      "name": "bucketFilled",
      "msg": "Bucket already filled"
    },
    {
      "code": 6025,
      "name": "sampleOutsideBucket",
      "msg": "Sample publish time outside the bucket"
    },
    {
      "code": 6026,
      "name": "notEnoughSamples",
      "msg": "Not enough samples"
    },
    {
      "code": 6027,
      "name": "notExpired",
      "msg": "Not expired"
    },
    {
      "code": 6028,
      "name": "poolCapExceeded",
      "msg": "Pool cap exceeded"
    },
    {
      "code": 6029,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6030,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6031,
      "name": "feeTooHigh",
      "msg": "Fee too high"
    },
    {
      "code": 6032,
      "name": "invalidSchedule",
      "msg": "Invalid schedule"
    },
    {
      "code": 6033,
      "name": "horizonOutOfRange",
      "msg": "Horizon out of range"
    },
    {
      "code": 6034,
      "name": "poolPaused",
      "msg": "Pool is paused"
    },
    {
      "code": 6035,
      "name": "insufficientFreeFunds",
      "msg": "Insufficient free funds"
    },
    {
      "code": 6036,
      "name": "invalidMint",
      "msg": "Invalid mint"
    },
    {
      "code": 6037,
      "name": "zeroAmount",
      "msg": "Zero amount"
    },
    {
      "code": 6038,
      "name": "epochFailed",
      "msg": "Epoch failed"
    },
    {
      "code": 6039,
      "name": "settlementPending",
      "msg": "A settlement is pending on this plan"
    },
    {
      "code": 6040,
      "name": "epochKindMismatch",
      "msg": "Epoch kind does not match the plan"
    },
    {
      "code": 6041,
      "name": "notWheelPlan",
      "msg": "Not a wheel plan"
    },
    {
      "code": 6042,
      "name": "wrongPhase",
      "msg": "Wrong plan phase"
    },
    {
      "code": 6043,
      "name": "invalidAccount",
      "msg": "Invalid account"
    },
    {
      "code": 6044,
      "name": "invalidLendAccounts",
      "msg": "Invalid Jupiter Lend accounts"
    },
    {
      "code": 6045,
      "name": "notFullyVerified",
      "msg": "Price update not fully verified"
    },
    {
      "code": 6046,
      "name": "invalidPlanParams",
      "msg": "Invalid plan parameters"
    },
    {
      "code": 6047,
      "name": "notImplemented",
      "msg": "Not implemented yet (ships in a program upgrade)"
    },
    {
      "code": 6048,
      "name": "roundTooSmall",
      "msg": "Round notional below the minimum (1 USDC)"
    }
  ],
  "types": [
    {
      "name": "asset",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "decimals",
            "type": "u8"
          },
          {
            "name": "pythFeedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "spotFeed",
            "docs": [
              "Pyth sponsored push-feed account (PriceUpdateV2 owned by the receiver) used for auction spot"
            ],
            "type": "pubkey"
          },
          {
            "name": "lendFTokenMint",
            "docs": [
              "Jupiter Lend fToken mint for this asset's market (Pubkey::default() = no Lend, plain vault e.g. tBTC)"
            ],
            "type": "pubkey"
          },
          {
            "name": "strikeTick",
            "type": "u64"
          },
          {
            "name": "maxConfBps",
            "type": "u16"
          },
          {
            "name": "maxSpotMoveBps",
            "type": "u16"
          },
          {
            "name": "maxSpotAgeSecs",
            "type": "u32"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "assetParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "decimals",
            "type": "u8"
          },
          {
            "name": "pythFeedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "spotFeed",
            "type": "pubkey"
          },
          {
            "name": "strikeTick",
            "type": "u64"
          },
          {
            "name": "maxConfBps",
            "type": "u16"
          },
          {
            "name": "maxSpotMoveBps",
            "type": "u16"
          },
          {
            "name": "maxSpotAgeSecs",
            "type": "u32"
          },
          {
            "name": "enabled",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "collateralWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "plan",
            "type": "pubkey"
          },
          {
            "name": "owed",
            "type": "u64"
          },
          {
            "name": "paid",
            "type": "u64"
          },
          {
            "name": "sharesBurned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "feeRecipient",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "createPlanArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "side",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "quick",
            "type": "bool"
          },
          {
            "name": "targetStrike",
            "type": "u64"
          },
          {
            "name": "exitStrike",
            "type": "u64"
          },
          {
            "name": "sizeTotal",
            "type": "u64"
          },
          {
            "name": "lockStrike",
            "type": "bool"
          },
          {
            "name": "band",
            "type": "u64"
          },
          {
            "name": "exitBand",
            "type": "u64"
          },
          {
            "name": "minPremiumBpsPerDay",
            "type": "u16"
          },
          {
            "name": "maxExpirySecs",
            "type": "u32"
          },
          {
            "name": "horizonEnd",
            "type": "i64"
          },
          {
            "name": "maxRoundsPerDay",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "epoch",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "epochKind"
              }
            }
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "nBuckets",
            "type": "u8"
          },
          {
            "name": "bucketSecs",
            "type": "u32"
          },
          {
            "name": "bucketToleranceSecs",
            "docs": [
              "u32 (BUILD says u8) so a Plan-B tolerance of a whole 300 s bucket fits"
            ],
            "type": "u32"
          },
          {
            "name": "graceSecs",
            "type": "u32"
          },
          {
            "name": "samples",
            "type": {
              "array": [
                "u64",
                10
              ]
            }
          },
          {
            "name": "sampleMask",
            "type": "u16"
          },
          {
            "name": "settlePrice",
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "epochStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "epochFailed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "pubkey"
          },
          {
            "name": "nSamples",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "epochKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "std"
          },
          {
            "name": "quick"
          }
        ]
      }
    },
    {
      "name": "epochOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "pubkey"
          },
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "expiry",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "epochResolved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "pubkey"
          },
          {
            "name": "settlePrice",
            "type": "u64"
          },
          {
            "name": "nSamples",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "epochStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "sampling"
          },
          {
            "name": "resolved"
          },
          {
            "name": "failed"
          }
        ]
      }
    },
    {
      "name": "openRoundArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundIndex",
            "type": "u32"
          },
          {
            "name": "strike",
            "type": "u64"
          },
          {
            "name": "size",
            "type": "u64"
          },
          {
            "name": "auctionSecs",
            "type": "u32"
          },
          {
            "name": "premiumStart",
            "type": "u64"
          },
          {
            "name": "premiumFloor",
            "type": "u64"
          },
          {
            "name": "memoHash",
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
      "name": "phase",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "accumulate"
          },
          {
            "name": "exit"
          }
        ]
      }
    },
    {
      "name": "plan",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "assetMint",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "side",
            "type": {
              "defined": {
                "name": "side"
              }
            }
          },
          {
            "name": "phase",
            "type": {
              "defined": {
                "name": "phase"
              }
            }
          },
          {
            "name": "quick",
            "type": "bool"
          },
          {
            "name": "targetStrike",
            "type": "u64"
          },
          {
            "name": "lockStrike",
            "type": "bool"
          },
          {
            "name": "band",
            "type": "u64"
          },
          {
            "name": "strikeMin",
            "type": "u64"
          },
          {
            "name": "strikeMax",
            "type": "u64"
          },
          {
            "name": "exitStrike",
            "type": "u64"
          },
          {
            "name": "exitBand",
            "type": "u64"
          },
          {
            "name": "callStrikeMin",
            "type": "u64"
          },
          {
            "name": "callStrikeMax",
            "type": "u64"
          },
          {
            "name": "sizeTotal",
            "type": "u64"
          },
          {
            "name": "sizeFilled",
            "type": "u64"
          },
          {
            "name": "collateralPrincipal",
            "docs": [
              "USDC (Buy / Wheel-Accumulate) or asset units (Sell / Wheel-Exit) principal deposited"
            ],
            "type": "u64"
          },
          {
            "name": "lendShares",
            "docs": [
              "fTokens held by the plan's lend_auth vault for the current phase's market"
            ],
            "type": "u64"
          },
          {
            "name": "pendingSettlement",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "minPremiumBpsPerDay",
            "type": "u16"
          },
          {
            "name": "maxExpirySecs",
            "type": "u32"
          },
          {
            "name": "horizonEnd",
            "type": "i64"
          },
          {
            "name": "maxRoundsPerDay",
            "type": "u8"
          },
          {
            "name": "roundsToday",
            "type": "u8"
          },
          {
            "name": "dayIndex",
            "type": "u32"
          },
          {
            "name": "roundCount",
            "type": "u32"
          },
          {
            "name": "activeRound",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "planStatus"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "lendAuthBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "planClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "plan",
            "type": "pubkey"
          },
          {
            "name": "collateralReturned",
            "type": "u64"
          },
          {
            "name": "assetReturned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "planCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "plan",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "quick",
            "type": "bool"
          },
          {
            "name": "targetStrike",
            "type": "u64"
          },
          {
            "name": "exitStrike",
            "type": "u64"
          },
          {
            "name": "sizeTotal",
            "type": "u64"
          },
          {
            "name": "collateralPrincipal",
            "type": "u64"
          },
          {
            "name": "lendShares",
            "type": "u64"
          },
          {
            "name": "horizonEnd",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "planExpired",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "plan",
            "type": "pubkey"
          },
          {
            "name": "collateralReturned",
            "type": "u64"
          },
          {
            "name": "assetReturned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "planFlipped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "plan",
            "type": "pubkey"
          },
          {
            "name": "sizeTotal",
            "type": "u64"
          },
          {
            "name": "lendShares",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "planStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "filled"
          },
          {
            "name": "closed"
          }
        ]
      }
    },
    {
      "name": "planUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "plan",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "pool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "maxPremiumBpsOfNotional",
            "type": "u16"
          },
          {
            "name": "maxOpenNotional",
            "type": "u64"
          },
          {
            "name": "maxUtilizationBps",
            "type": "u16"
          },
          {
            "name": "spendWindowSecs",
            "type": "u32"
          },
          {
            "name": "spendWindowStart",
            "type": "i64"
          },
          {
            "name": "spendWindowCap",
            "type": "u64"
          },
          {
            "name": "spendWindowSpent",
            "type": "u64"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "shareMint",
            "type": "pubkey"
          },
          {
            "name": "lendShares",
            "type": "u64"
          },
          {
            "name": "reservedUsdc",
            "docs": [
              "USDC held outside the vaults: escrow of live pool Calls (= call_open_notional) + receivables of exercised",
              "pool Puts awaiting withdraw_collateral."
            ],
            "type": "u64"
          },
          {
            "name": "reservedWsol",
            "docs": [
              "WSOL held outside the vaults: escrow of live pool Puts (= put_open_size) + receivables of exercised pool Calls",
              "awaiting withdraw_collateral."
            ],
            "type": "u64"
          },
          {
            "name": "openNotional",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "lendAuthBump",
            "type": "u8"
          },
          {
            "name": "shareMintBump",
            "type": "u8"
          },
          {
            "name": "putOpenSize",
            "docs": [
              "Σ size (WSOL) escrowed by live pool Puts (subset of reserved_wsol)."
            ],
            "type": "u64"
          },
          {
            "name": "putOpenNotional",
            "docs": [
              "Σ strike notional (USDC) of live pool Puts: what the pool receives if they are exercised."
            ],
            "type": "u64"
          },
          {
            "name": "callOpenNotional",
            "docs": [
              "Σ notional (USDC) escrowed by live pool Calls (subset of reserved_usdc)."
            ],
            "type": "u64"
          },
          {
            "name": "callOpenSize",
            "docs": [
              "Σ size (WSOL) of live pool Calls: what the pool receives if they are exercised."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lp",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "nav",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxPremiumBpsOfNotional",
            "type": "u16"
          },
          {
            "name": "maxOpenNotional",
            "type": "u64"
          },
          {
            "name": "maxUtilizationBps",
            "type": "u16"
          },
          {
            "name": "spendWindowSecs",
            "type": "u32"
          },
          {
            "name": "spendWindowCap",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "poolWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lp",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "usdcOut",
            "type": "u64"
          },
          {
            "name": "wsolOut",
            "type": "u64"
          },
          {
            "name": "fTokenOut",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "round",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "plan",
            "type": "pubkey"
          },
          {
            "name": "asset",
            "type": "pubkey"
          },
          {
            "name": "roundIndex",
            "type": "u32"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "roundKind"
              }
            }
          },
          {
            "name": "strike",
            "type": "u64"
          },
          {
            "name": "size",
            "type": "u64"
          },
          {
            "name": "notional",
            "type": "u64"
          },
          {
            "name": "epoch",
            "type": "pubkey"
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "auctionStart",
            "type": "i64"
          },
          {
            "name": "auctionSecs",
            "type": "u32"
          },
          {
            "name": "poolDelaySecs",
            "type": "u32"
          },
          {
            "name": "rentPayer",
            "type": "pubkey"
          },
          {
            "name": "premiumStart",
            "type": "u64"
          },
          {
            "name": "premiumFloor",
            "type": "u64"
          },
          {
            "name": "spotAtOpen",
            "type": "u64"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "makerIsPool",
            "type": "bool"
          },
          {
            "name": "premiumPaid",
            "type": "u64"
          },
          {
            "name": "feePaid",
            "type": "u64"
          },
          {
            "name": "exercised",
            "type": "u8"
          },
          {
            "name": "settlePrice",
            "type": "u64"
          },
          {
            "name": "memoHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "roundStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "escrowBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "roundCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "plan",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "roundKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "put"
          },
          {
            "name": "call"
          }
        ]
      }
    },
    {
      "name": "roundOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "plan",
            "type": "pubkey"
          },
          {
            "name": "epoch",
            "type": "pubkey"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "strike",
            "type": "u64"
          },
          {
            "name": "size",
            "type": "u64"
          },
          {
            "name": "notional",
            "type": "u64"
          },
          {
            "name": "expiry",
            "type": "i64"
          },
          {
            "name": "premiumStart",
            "type": "u64"
          },
          {
            "name": "premiumFloor",
            "type": "u64"
          },
          {
            "name": "spotAtOpen",
            "type": "u64"
          },
          {
            "name": "memoHash",
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
      "name": "roundResolved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "plan",
            "type": "pubkey"
          },
          {
            "name": "settlePrice",
            "type": "u64"
          },
          {
            "name": "exercised",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "roundStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "auction"
          },
          {
            "name": "live"
          },
          {
            "name": "cancelled"
          },
          {
            "name": "resolved"
          },
          {
            "name": "settled"
          },
          {
            "name": "unwound"
          }
        ]
      }
    },
    {
      "name": "roundTaken",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "plan",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "isPool",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "roundUnwound",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "plan",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "samplePosted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epoch",
            "type": "pubkey"
          },
          {
            "name": "bucket",
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "publishTime",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "side",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "buy"
          },
          {
            "name": "sell"
          },
          {
            "name": "wheel"
          }
        ]
      }
    },
    {
      "name": "updatePlanArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "targetStrike",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "band",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "horizonEnd",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "minPremiumBpsPerDay",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "sizeTotal",
            "type": {
              "option": "u64"
            }
          }
        ]
      }
    }
  ]
};
