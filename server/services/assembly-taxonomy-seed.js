// AGX assembly code library — global seed taxonomy (Trades → Systems → Variants).
// Central-Florida-first, research-sourced. GENERATED from the reviewed library artifact;
// edit here to grow the catalog, then the boot seeder layers additions in idempotently.
// 17 trades · 107 systems · 449 variants.

module.exports = [
  {
    "code": "ROOF",
    "name": "Roofing",
    "unit": "SQ",
    "systems": [
      {
        "code": "ASHNG",
        "name": "Asphalt Shingle",
        "unit": "SQ",
        "variants": [
          {
            "code": "3TAB",
            "name": "3-tab",
            "note": "Budget / repair-match; single-layer"
          },
          {
            "code": "ARCH",
            "name": "Architectural",
            "note": "CF standard, laminated, 130 mph"
          },
          {
            "code": "LUX",
            "name": "Luxury / designer",
            "note": "Slate & shake look, multi-layer"
          },
          {
            "code": "IR4",
            "name": "Impact-resistant",
            "note": "Class 4, SBS-modified; insurance credit"
          }
        ]
      },
      {
        "code": "SSMTL",
        "name": "Standing-Seam Metal",
        "unit": "SQ",
        "variants": [
          {
            "code": "SNAP24",
            "name": "24ga snap-lock",
            "note": "Concealed fastener, common residential"
          },
          {
            "code": "SNAP26",
            "name": "26ga snap-lock",
            "note": "Lighter economy gauge"
          },
          {
            "code": "MECH24",
            "name": "24ga mechanical-seam",
            "note": "Field-crimped; best high-wind"
          },
          {
            "code": "ALUMSS",
            "name": "Aluminum SS",
            "note": "Coastal / salt-air"
          }
        ]
      },
      {
        "code": "EFMTL",
        "name": "Exposed-Fastener Metal",
        "unit": "SQ",
        "variants": [
          {
            "code": "5V26",
            "name": "5V-crimp 26ga",
            "note": "FL classic, through-fastened"
          },
          {
            "code": "5V24",
            "name": "5V-crimp 24ga",
            "note": "Heavier upgrade"
          },
          {
            "code": "RPANEL",
            "name": "R-Panel / PBR",
            "note": "Ribbed, economical large-area"
          },
          {
            "code": "ALUM5V",
            "name": "Aluminum 5V",
            "note": "Coastal grade"
          }
        ]
      },
      {
        "code": "CTILE",
        "name": "Concrete Tile",
        "unit": "SQ",
        "variants": [
          {
            "code": "FLAT",
            "name": "Flat profile",
            "note": "Modern / slate look"
          },
          {
            "code": "LOWMED",
            "name": "Low / medium barrel",
            "note": "Gentle-curve roll"
          },
          {
            "code": "HIGHS",
            "name": "High S-barrel",
            "note": "Spanish/Med; Eagle Capistrano"
          },
          {
            "code": "DBLEAG",
            "name": "Double-thick flat",
            "note": "Deeper shadow line"
          }
        ]
      },
      {
        "code": "KTILE",
        "name": "Clay Tile",
        "unit": "SQ",
        "variants": [
          {
            "code": "TWOPC",
            "name": "Two-piece pan & cover",
            "note": "True mission barrel, premium"
          },
          {
            "code": "ONEPCS",
            "name": "One-piece S-tile",
            "note": "Interlocking, faster install"
          },
          {
            "code": "FLATCL",
            "name": "Flat interlocking",
            "note": "Contemporary clay"
          }
        ]
      },
      {
        "code": "LOSLP",
        "name": "Low-Slope / Flat",
        "unit": "SQ",
        "variants": [
          {
            "code": "TPO",
            "name": "TPO membrane",
            "note": "Welded seams, reflective; lanai/additions"
          },
          {
            "code": "SAMB",
            "name": "Self-adhered mod-bit",
            "note": "Peel-&-stick, no torch"
          },
          {
            "code": "MODBIT",
            "name": "Torch / hot-mop mod-bit",
            "note": "Larger flat decks"
          },
          {
            "code": "BUR",
            "name": "Built-up (tar & gravel)",
            "note": "Legacy / commercial"
          }
        ]
      },
      {
        "code": "SCMTL",
        "name": "Stone-Coated Metal",
        "unit": "SQ",
        "variants": [
          {
            "code": "SCSHAKE",
            "name": "Shake profile",
            "note": "Steel, wood-shake look"
          },
          {
            "code": "SCTILE",
            "name": "Tile / barrel profile",
            "note": "Tile look, light weight"
          },
          {
            "code": "SCSHGL",
            "name": "Shingle profile",
            "note": "Dimensional, interlocking"
          }
        ]
      }
    ]
  },
  {
    "code": "GUTR",
    "name": "Gutters & Downspouts",
    "unit": "LF",
    "systems": [
      {
        "code": "ALGUT",
        "name": "Seamless Aluminum",
        "unit": "LF",
        "variants": [
          {
            "code": "5K027",
            "name": "5\" K-style .027",
            "note": "Standard residential seamless"
          },
          {
            "code": "6K032",
            "name": "6\" K-style .032",
            "note": "High-capacity + heavier gauge"
          },
          {
            "code": "5HR",
            "name": "5\" half-round",
            "note": "Historic / architectural"
          },
          {
            "code": "6HR",
            "name": "6\" half-round",
            "note": "Higher flow"
          },
          {
            "code": "032HD",
            "name": ".032 heavy-gauge",
            "note": "Dent/tear resistance upgrade"
          }
        ]
      },
      {
        "code": "STLGUT",
        "name": "Steel / Galvalume",
        "unit": "LF",
        "variants": [
          {
            "code": "GALV5",
            "name": "5\" galvanized",
            "note": "Stronger; impact-prone runs"
          },
          {
            "code": "GALV6",
            "name": "6\" galvanized",
            "note": "Commercial / heavy"
          },
          {
            "code": "GALUME",
            "name": "Galvalume",
            "note": "Better corrosion than galvanized"
          }
        ]
      },
      {
        "code": "CUGUT",
        "name": "Copper",
        "unit": "LF",
        "variants": [
          {
            "code": "5KCU",
            "name": "K-style copper",
            "note": "16 oz, premium, patinas"
          },
          {
            "code": "HRCU",
            "name": "Half-round copper",
            "note": "Historic / high-end"
          }
        ]
      },
      {
        "code": "VNLGUT",
        "name": "Vinyl",
        "unit": "LF",
        "variants": [
          {
            "code": "5KVNL",
            "name": "5\" K-style vinyl",
            "note": "DIY / budget; UV-degrades in FL"
          }
        ]
      },
      {
        "code": "DSPOUT",
        "name": "Downspouts",
        "unit": "LF",
        "variants": [
          {
            "code": "2X3",
            "name": "2\"×3\" rectangular",
            "note": "Pairs with 5\" gutter"
          },
          {
            "code": "3X4",
            "name": "3\"×4\" rectangular",
            "note": "Larger flow / 6\" gutter"
          },
          {
            "code": "3RND",
            "name": "3\" round",
            "note": "Round / decorative"
          },
          {
            "code": "4RND",
            "name": "4\" round",
            "note": "High-capacity"
          }
        ]
      },
      {
        "code": "GGUARD",
        "name": "Gutter Guards",
        "unit": "LF",
        "variants": [
          {
            "code": "MESH",
            "name": "Micro-mesh",
            "note": "Blocks needles & grit"
          },
          {
            "code": "SCREEN",
            "name": "Perforated screen",
            "note": "Economical debris block"
          },
          {
            "code": "RVRSCRV",
            "name": "Reverse-curve hood",
            "note": "Surface-tension (LeafProof)"
          },
          {
            "code": "DSTRAIN",
            "name": "Downspout strainer",
            "note": "Basket at the drop (EA)"
          }
        ]
      }
    ]
  },
  {
    "code": "SOFT",
    "name": "Soffit & Fascia",
    "unit": "LF",
    "systems": [
      {
        "code": "ALSOF",
        "name": "Vented Aluminum Soffit",
        "unit": "SF",
        "variants": [
          {
            "code": "D6VENT",
            "name": "Double-6 vented",
            "note": "Two 6\" planks, one vented"
          },
          {
            "code": "T4VENT",
            "name": "Triple-4 center-vent",
            "note": "Three 4\" planks, center strip"
          },
          {
            "code": "12CTR",
            "name": "12\" center-vent",
            "note": "Full panel, center venting"
          },
          {
            "code": "SOLID",
            "name": "Solid",
            "note": "Porch ceilings / non-vent"
          },
          {
            "code": "FULLV",
            "name": "Full-vent (lanced)",
            "note": "Max intake"
          }
        ]
      },
      {
        "code": "VNLSOF",
        "name": "Vinyl Soffit",
        "unit": "SF",
        "variants": [
          {
            "code": "VVENT",
            "name": "Vented",
            "note": "Triple-4 / double-5 hollow-back"
          },
          {
            "code": "VSOLID",
            "name": "Solid",
            "note": "Porch / rake"
          },
          {
            "code": "VBEAD",
            "name": "Beaded porch",
            "note": "Beadboard look"
          }
        ]
      },
      {
        "code": "HZSOF",
        "name": "Hardie / Fiber-Cement Soffit",
        "unit": "SF",
        "variants": [
          {
            "code": "HVENT",
            "name": "Vented",
            "note": "5.0 sq-in NFA per LF"
          },
          {
            "code": "HVPLUS",
            "name": "VentedPlus",
            "note": "12.6 sq-in NFA, high intake"
          },
          {
            "code": "HSOLID",
            "name": "Non-vented",
            "note": "Solid FC panel"
          },
          {
            "code": "HBEAD",
            "name": "Beaded porch",
            "note": "1/4\" beaded panel"
          }
        ]
      },
      {
        "code": "WDSOF",
        "name": "Wood Soffit",
        "unit": "SF",
        "variants": [
          {
            "code": "PLYVNT",
            "name": "Plywood / T1-11 vented",
            "note": "Cut-in vents"
          },
          {
            "code": "TGPINE",
            "name": "T&G beadboard",
            "note": "Decorative porch eave"
          }
        ]
      },
      {
        "code": "ALFAS",
        "name": "Aluminum Fascia Wrap",
        "unit": "LF",
        "variants": [
          {
            "code": "WRAP6",
            "name": "6\" wrap",
            "note": "Cap over 1×6 wood"
          },
          {
            "code": "WRAP8",
            "name": "8\" wrap",
            "note": "Over 1×8"
          },
          {
            "code": "WRAP10",
            "name": "10\" wrap",
            "note": "Over 2× / tall"
          },
          {
            "code": "COILBND",
            "name": "Custom coil-bent",
            "note": "Field-braked flat"
          }
        ]
      },
      {
        "code": "WDFAS",
        "name": "Wood / PVC Fascia",
        "unit": "LF",
        "variants": [
          {
            "code": "1X6",
            "name": "1×6 dimensional",
            "note": "Standard board"
          },
          {
            "code": "1X8",
            "name": "1×8 dimensional",
            "note": "Taller eaves"
          },
          {
            "code": "2XSUB",
            "name": "2× sub-fascia",
            "note": "Structural backing"
          },
          {
            "code": "PVCTRIM",
            "name": "Cellular PVC (Azek)",
            "note": "Rot-proof FL upgrade"
          }
        ]
      },
      {
        "code": "HZFAS",
        "name": "Hardie / FC Fascia",
        "unit": "LF",
        "variants": [
          {
            "code": "HTFAS",
            "name": "HardieTrim fascia",
            "note": "Pairs with HardieSoffit"
          }
        ]
      }
    ]
  },
  {
    "code": "STUC",
    "name": "Stucco & Plaster",
    "unit": "SF",
    "systems": [
      {
        "code": "HC3",
        "name": "Traditional 3-Coat (hard-coat)",
        "unit": "SF",
        "variants": [
          {
            "code": "SANDFLT",
            "name": "Sand / float",
            "note": "Most common FL finish"
          },
          {
            "code": "KNOCKDWN",
            "name": "Knockdown",
            "note": "Mottled low-relief; hides imperfections"
          },
          {
            "code": "DASH",
            "name": "Dash / splatter",
            "note": "Thrown aggregate; durable classic"
          },
          {
            "code": "LACE",
            "name": "Lace / skip-trowel",
            "note": "Raised islands; very common FL"
          },
          {
            "code": "SMOOTH",
            "name": "Smooth (Santa Barbara)",
            "note": "Steel-troweled, high-end"
          },
          {
            "code": "WORM",
            "name": "Worm / swirl",
            "note": "Decorative channels"
          }
        ]
      },
      {
        "code": "OC",
        "name": "One-Coat (over foam)",
        "unit": "SF",
        "variants": [
          {
            "code": "OCFOAM",
            "name": "Over foam board",
            "note": "~3/8\" fiber blend + R-value"
          },
          {
            "code": "OCFINISH",
            "name": "Finish texture",
            "note": "Same texture menu as hard-coat"
          }
        ]
      },
      {
        "code": "EIFS",
        "name": "EIFS (synthetic stucco)",
        "unit": "SF",
        "variants": [
          {
            "code": "EIFSBARR",
            "name": "Barrier",
            "note": "No drainage cavity (older)"
          },
          {
            "code": "EIFSDRN",
            "name": "Drainage / water-managed",
            "note": "Code-compliant; preferred in FL"
          },
          {
            "code": "EIFSACR",
            "name": "Acrylic finish",
            "note": "Factory-tinted topcoat"
          }
        ]
      },
      {
        "code": "REPAIR",
        "name": "Stucco Repair / Patch",
        "unit": "SF",
        "variants": [
          {
            "code": "CRACKRTE",
            "name": "Crack rout & seal",
            "note": "Backer rod + elastomeric"
          },
          {
            "code": "PATCH",
            "name": "Patch & texture-match",
            "note": "Re-lath + blend to existing"
          },
          {
            "code": "DELAM",
            "name": "Delamination / moisture",
            "note": "Drummy stucco + WRB correction"
          }
        ]
      },
      {
        "code": "RECOAT",
        "name": "Elastomeric Re-coat",
        "unit": "SF",
        "variants": [
          {
            "code": "FOG",
            "name": "Fog / color coat",
            "note": "Cementitious color refresh"
          },
          {
            "code": "ELASTO",
            "name": "Elastomeric bridging",
            "note": "10-20 mil waterproofing"
          }
        ]
      },
      {
        "code": "SKIM",
        "name": "Skim / Level",
        "unit": "SF",
        "variants": [
          {
            "code": "SKIMSMTH",
            "name": "Skim to smooth",
            "note": "Convert texture to modern smooth"
          },
          {
            "code": "BROWNPTC",
            "name": "Brown-coat leveling",
            "note": "Re-plane wavy walls"
          }
        ]
      }
    ]
  },
  {
    "code": "SIDG",
    "name": "Siding",
    "unit": "SF",
    "systems": [
      {
        "code": "FCLAP",
        "name": "Fiber-Cement Lap (Hardie)",
        "unit": "SF",
        "variants": [
          {
            "code": "FCSMTH",
            "name": "Smooth lap",
            "note": "Widths 5.25\"–8.25\""
          },
          {
            "code": "FCCEDAR",
            "name": "Cedarmill woodgrain",
            "note": "Most popular Hardie texture"
          },
          {
            "code": "FCBEAD",
            "name": "Beaded",
            "note": "Shadow-line, coastal look"
          },
          {
            "code": "FCCOLOR",
            "name": "ColorPlus",
            "note": "Factory baked-on color"
          }
        ]
      },
      {
        "code": "FCPANEL",
        "name": "Fiber-Cement Panel / Vertical",
        "unit": "SF",
        "variants": [
          {
            "code": "FCPBB",
            "name": "Board & batten",
            "note": "Panel + battens; farmhouse"
          },
          {
            "code": "FCPSTUC",
            "name": "Stucco-panel",
            "note": "Stucco-look sheet"
          },
          {
            "code": "FCPSMTH",
            "name": "Smooth panel",
            "note": "Modern flush walls"
          }
        ]
      },
      {
        "code": "FCSHAKE",
        "name": "Fiber-Cement Shingle / Shake",
        "unit": "SF",
        "variants": [
          {
            "code": "FCSTRT",
            "name": "Straight-edge",
            "note": "Uniform bottom, panelized"
          },
          {
            "code": "FCSTAG",
            "name": "Staggered-edge",
            "note": "Rustic accent"
          }
        ]
      },
      {
        "code": "VINYL",
        "name": "Vinyl",
        "unit": "SF",
        "variants": [
          {
            "code": "VDBL4",
            "name": "Double 4\"",
            "note": "Economy lap"
          },
          {
            "code": "VDBL5",
            "name": "Double 5\"",
            "note": "Wider reveal"
          },
          {
            "code": "VDUTCH",
            "name": "Dutch lap",
            "note": "Deeper shadow line"
          },
          {
            "code": "VBB",
            "name": "Board & batten",
            "note": "Vertical accent"
          },
          {
            "code": "VSHAKE",
            "name": "Shake / scallop",
            "note": "Gable accent"
          },
          {
            "code": "VINSUL",
            "name": "Insulated",
            "note": "Foam-backed, +R"
          }
        ]
      },
      {
        "code": "EWOOD",
        "name": "Engineered Wood (LP)",
        "unit": "SF",
        "variants": [
          {
            "code": "EWCEDAR",
            "name": "Cedar lap",
            "note": "Embossed grain, prefinished"
          },
          {
            "code": "EWSMTH",
            "name": "Smooth lap",
            "note": "Modern painted look"
          },
          {
            "code": "EWPANEL",
            "name": "Panel / vertical",
            "note": "Board & batten / flush"
          },
          {
            "code": "EWSHAKE",
            "name": "Shake panel",
            "note": "4-ft panels, low labor"
          }
        ]
      },
      {
        "code": "ALUM",
        "name": "Aluminum",
        "unit": "SF",
        "variants": [
          {
            "code": "ALLAP",
            "name": "Horizontal lap",
            "note": "Repair / legacy"
          },
          {
            "code": "ALSOFFIT",
            "name": "Soffit / fascia wrap",
            "note": "Common FL trim scope"
          }
        ]
      },
      {
        "code": "MASV",
        "name": "Masonry / Stone Veneer",
        "unit": "SF",
        "variants": [
          {
            "code": "MSVLEDGE",
            "name": "Ledgestone (dry-stack)",
            "note": "Thin veneer, no grout"
          },
          {
            "code": "MSVFIELD",
            "name": "Fieldstone / river",
            "note": "Grouted rounded"
          },
          {
            "code": "THINBRK",
            "name": "Thin brick veneer",
            "note": "1/2\"–1\" brick faces"
          },
          {
            "code": "STNSEAL",
            "name": "Veneer seal",
            "note": "Stain/moisture protection"
          }
        ]
      }
    ]
  },
  {
    "code": "PAINT",
    "name": "Painting & Coatings",
    "unit": "SF",
    "systems": [
      {
        "code": "EXTRP",
        "name": "Exterior Repaint",
        "unit": "SF",
        "variants": [
          {
            "code": "EX1COAT",
            "name": "1-coat refresh",
            "note": "Over sound like-color"
          },
          {
            "code": "EX2COAT",
            "name": "2-coat system",
            "note": "Standard durability spec"
          },
          {
            "code": "EXBODY",
            "name": "Body / field",
            "note": "Main wall color line"
          },
          {
            "code": "EXTRIM",
            "name": "Trim / fascia / doors",
            "note": "Higher sheen"
          },
          {
            "code": "EXACCNT",
            "name": "Accent / front-door",
            "note": "Feature color"
          },
          {
            "code": "EXPRIME",
            "name": "Prime / spot-prime",
            "note": "Masonry primer on new stucco"
          }
        ]
      },
      {
        "code": "INTRP",
        "name": "Interior Repaint",
        "unit": "SF",
        "variants": [
          {
            "code": "INWALL",
            "name": "Walls",
            "note": "Flat / eggshell / satin"
          },
          {
            "code": "INCEIL",
            "name": "Ceilings",
            "note": "Flat ceiling white"
          },
          {
            "code": "INTRIM",
            "name": "Trim / doors / base",
            "note": "Semi-gloss enamel"
          },
          {
            "code": "INFLAT",
            "name": "Flat / matte",
            "note": "Hides imperfections"
          },
          {
            "code": "INEGG",
            "name": "Eggshell / satin",
            "note": "Washable standard"
          },
          {
            "code": "INSEMI",
            "name": "Semi-gloss",
            "note": "Kitchen/bath, scrubbable"
          }
        ]
      },
      {
        "code": "ELASTO",
        "name": "Elastomeric Coating",
        "unit": "SF",
        "variants": [
          {
            "code": "EL1CT",
            "name": "Single-coat",
            "note": "High-build over sound stucco"
          },
          {
            "code": "EL2CT",
            "name": "2-coat (10-20 mil)",
            "note": "Waterproof + bridge cracks"
          },
          {
            "code": "ELPATCH",
            "name": "Crack prep + patch",
            "note": "Rout/caulk before spray"
          }
        ]
      },
      {
        "code": "STAIN",
        "name": "Stain & Clear",
        "unit": "SF",
        "variants": [
          {
            "code": "STTRANS",
            "name": "Transparent / semi",
            "note": "Shows grain; decks/fences"
          },
          {
            "code": "STSOLID",
            "name": "Solid-color",
            "note": "Opaque, longer life"
          },
          {
            "code": "STSEAL",
            "name": "Clear sealer",
            "note": "Water-repellent, no color"
          }
        ]
      },
      {
        "code": "MASWP",
        "name": "Masonry / Waterproof Coating",
        "unit": "SF",
        "variants": [
          {
            "code": "WPFLEX",
            "name": "Flexible masonry paint",
            "note": "Crack-bridging + waterproof"
          },
          {
            "code": "WPBLOCK",
            "name": "Block filler / primer",
            "note": "Fills CMU pinholes"
          },
          {
            "code": "WPNEG",
            "name": "Below-grade / negative-side",
            "note": "Cementitious foundations"
          }
        ]
      },
      {
        "code": "CAB",
        "name": "Cabinet / Fine Finish",
        "unit": "EA",
        "variants": [
          {
            "code": "CABENAM",
            "name": "Sprayed enamel",
            "note": "Degloss + spray urethane"
          },
          {
            "code": "CABLF",
            "name": "Trim / millwork",
            "note": "Priced per LF"
          }
        ]
      },
      {
        "code": "EPOXY",
        "name": "Epoxy / Floor Coating",
        "unit": "SF",
        "variants": [
          {
            "code": "EP1PT",
            "name": "1-part epoxy/acrylic",
            "note": "DIY-grade garage"
          },
          {
            "code": "EP2PT",
            "name": "2-part 100% solids",
            "note": "Durable garage system"
          },
          {
            "code": "EPFLAKE",
            "name": "Flake broadcast",
            "note": "Color-chip + topcoat"
          },
          {
            "code": "EPPOLY",
            "name": "Polyaspartic topcoat",
            "note": "Fast-cure, UV-stable"
          }
        ]
      }
    ]
  },
  {
    "code": "CONC",
    "name": "Concrete & Flatwork",
    "unit": "SF",
    "systems": [
      {
        "code": "SLAB",
        "name": "Slab-on-grade",
        "unit": "SF",
        "variants": [
          {
            "code": "SL4BRM",
            "name": "4\" broom, 3000 psi",
            "note": "FL residential standard"
          },
          {
            "code": "SL6BRM",
            "name": "6\" broom",
            "note": "Heavier loads / point loads"
          },
          {
            "code": "SLTROW",
            "name": "Smooth trowel",
            "note": "Covered / interior-transition"
          },
          {
            "code": "SLFIBR",
            "name": "Fiber / WWM",
            "note": "Crack-control add"
          },
          {
            "code": "SLTHICK",
            "name": "Thickened edge",
            "note": "Monolithic wall-bearing"
          }
        ]
      },
      {
        "code": "DRIVE",
        "name": "Driveway",
        "unit": "SF",
        "variants": [
          {
            "code": "DR4BRM",
            "name": "4\" broom, 3000 psi",
            "note": "Cars / light trucks"
          },
          {
            "code": "DR6BRM",
            "name": "6\" broom, 3500 psi",
            "note": "RV / boat / heavy"
          },
          {
            "code": "DRSAWCUT",
            "name": "Sawcut joints",
            "note": "Relief every ~10 ft"
          },
          {
            "code": "DRAPRON",
            "name": "Approach / apron",
            "note": "Road tie-in, permit"
          }
        ]
      },
      {
        "code": "WALK",
        "name": "Sidewalk / Flatwork",
        "unit": "SF",
        "variants": [
          {
            "code": "WK4BRM",
            "name": "4\" broom walk",
            "note": "Standard path"
          },
          {
            "code": "WKADA",
            "name": "ADA walk / ramp",
            "note": "Slope + warnings"
          },
          {
            "code": "WKTHICK",
            "name": "6\" cart / utility",
            "note": "Golf-cart traffic"
          }
        ]
      },
      {
        "code": "FOOT",
        "name": "Footing / Stemwall",
        "unit": "LF",
        "variants": [
          {
            "code": "FTMONO",
            "name": "Monolithic",
            "note": "Slab + footing poured together"
          },
          {
            "code": "FTSTEM",
            "name": "Stemwall",
            "note": "Elevated / flood-elevation"
          },
          {
            "code": "FTGRADE",
            "name": "Grade beam",
            "note": "Spanning poor soil"
          },
          {
            "code": "FT3000",
            "name": "3000 psi #5 cage",
            "note": "Typical residential"
          }
        ]
      },
      {
        "code": "DECOR",
        "name": "Decorative / Stamped",
        "unit": "SF",
        "variants": [
          {
            "code": "DCSTAMP",
            "name": "Stamped",
            "note": "Ashlar/slate/brick/wood mat"
          },
          {
            "code": "DCEXAGG",
            "name": "Exposed aggregate",
            "note": "Washed stone, reflects heat"
          },
          {
            "code": "DCSALT",
            "name": "Rock-salt",
            "note": "Pitted budget decorative"
          },
          {
            "code": "DCSTAIN",
            "name": "Acid-stain / integral color",
            "note": "Pairs with stamp"
          },
          {
            "code": "DCOVLAY",
            "name": "Overlay / micro-topping",
            "note": "Resurface + decorate"
          }
        ]
      },
      {
        "code": "POOLDK",
        "name": "Pool Deck",
        "unit": "SF",
        "variants": [
          {
            "code": "PDSPRAY",
            "name": "Spray / knockdown cool-deck",
            "note": "Dominant FL finish; cool-touch"
          },
          {
            "code": "PDSTAMP",
            "name": "Stamped",
            "note": "Patterned + sealer"
          },
          {
            "code": "PDBRMSL",
            "name": "Broom + sealer",
            "note": "Economy textured"
          },
          {
            "code": "PDRESURF",
            "name": "Resurface",
            "note": "Overlay tired deck"
          }
        ]
      },
      {
        "code": "REPAIR",
        "name": "Concrete Repair",
        "unit": "SF",
        "variants": [
          {
            "code": "RPCRKEP",
            "name": "Epoxy crack injection",
            "note": "Structural, stable cracks"
          },
          {
            "code": "RPCRKPU",
            "name": "PU crack injection",
            "note": "Active / wet cracks"
          },
          {
            "code": "RPSPALL",
            "name": "Spall / edge patch",
            "note": "Rebar treatment"
          },
          {
            "code": "RPRESURF",
            "name": "Resurface / overlay",
            "note": "Restore worn surface"
          },
          {
            "code": "RPLIFT",
            "name": "Slab-jack / foam level",
            "note": "Lift settled slab"
          },
          {
            "code": "RPJOINT",
            "name": "Joint re-seal",
            "note": "Re-caulk control joints"
          }
        ]
      }
    ]
  },
  {
    "code": "PAVR",
    "name": "Pavers & Hardscape",
    "unit": "SF",
    "systems": [
      {
        "code": "CPAV",
        "name": "Concrete Pavers",
        "unit": "SF",
        "variants": [
          {
            "code": "CP60MM",
            "name": "60mm",
            "note": "Patio / walkway / pool deck"
          },
          {
            "code": "CP80MM",
            "name": "80mm",
            "note": "Driveway / vehicle loads"
          },
          {
            "code": "CP6X9",
            "name": "6×9 rectangle",
            "note": "Workhorse module"
          },
          {
            "code": "CP6X6",
            "name": "6×6 square",
            "note": "Borders / accents"
          },
          {
            "code": "CPMODUL",
            "name": "3-pc modular",
            "note": "Random-look kit"
          },
          {
            "code": "CPLGSLAB",
            "name": "Large-format slab",
            "note": "Modern plank/slab"
          },
          {
            "code": "CPPERM",
            "name": "Permeable",
            "note": "Open-joint stormwater"
          }
        ]
      },
      {
        "code": "BPAV",
        "name": "Brick / Clay Pavers",
        "unit": "SF",
        "variants": [
          {
            "code": "BP4X8",
            "name": "4×8 clay",
            "note": "Color through, chip-proof"
          },
          {
            "code": "BPHOLL",
            "name": "Holland / rectangle",
            "note": "Standard clay"
          },
          {
            "code": "BPTUMBL",
            "name": "Tumbled / antiqued",
            "note": "Aged rounded edges"
          }
        ]
      },
      {
        "code": "TRAV",
        "name": "Travertine",
        "unit": "SF",
        "variants": [
          {
            "code": "TVFRENCH",
            "name": "French / Versailles set",
            "note": "Signature FL pool-deck"
          },
          {
            "code": "TV6X12",
            "name": "6×12 plank",
            "note": "Linear runs / borders"
          },
          {
            "code": "TVTUMBL",
            "name": "Tumbled",
            "note": "Weathered, slip-resistant"
          },
          {
            "code": "TVFILLHN",
            "name": "Filled & honed",
            "note": "Smoother, cleaner"
          },
          {
            "code": "TVCOPE",
            "name": "Bullnose coping",
            "note": "Pool-edge pieces"
          }
        ]
      },
      {
        "code": "PORC",
        "name": "Porcelain Pavers",
        "unit": "SF",
        "variants": [
          {
            "code": "PC24X24",
            "name": "24×24 (2cm)",
            "note": "Dense, no sealing"
          },
          {
            "code": "PC12X24",
            "name": "12×24 plank",
            "note": "Linear modern"
          },
          {
            "code": "PCWOOD",
            "name": "Wood-look",
            "note": "High slip rating"
          },
          {
            "code": "PCPEDEST",
            "name": "Pedestal-set",
            "note": "Raised over roof deck"
          }
        ]
      },
      {
        "code": "RETWAL",
        "name": "Retaining / Seat Wall",
        "unit": "SF",
        "variants": [
          {
            "code": "RWSRW",
            "name": "SRW block",
            "note": "Mortarless interlocking"
          },
          {
            "code": "RWGEO",
            "name": "Geogrid-reinforced",
            "note": "Taller / engineered"
          },
          {
            "code": "RWSEAT",
            "name": "Seat / garden wall",
            "note": "Low, capped"
          },
          {
            "code": "RWCAP",
            "name": "Cap units",
            "note": "Finishing course"
          }
        ]
      },
      {
        "code": "SEAL",
        "name": "Paver Sealing / Re-Sand",
        "unit": "SF",
        "variants": [
          {
            "code": "SLPENET",
            "name": "Penetrating natural",
            "note": "Matte; travertine / cool decks"
          },
          {
            "code": "SLFILMWL",
            "name": "Film wet-look / gloss",
            "note": "Darkens + shine"
          },
          {
            "code": "SLWATER",
            "name": "Water-based acrylic",
            "note": "Low-VOC, fast dry"
          },
          {
            "code": "SLSOLV",
            "name": "Solvent acrylic",
            "note": "Deeper color, higher gloss"
          },
          {
            "code": "SLPOLY",
            "name": "Polymeric re-sand",
            "note": "Binder joint sand"
          },
          {
            "code": "SLSILICA",
            "name": "Silica joint sand",
            "note": "Standard tight-joint fill"
          }
        ]
      },
      {
        "code": "COPE",
        "name": "Coping",
        "unit": "LF",
        "variants": [
          {
            "code": "CPBULL",
            "name": "Bullnose",
            "note": "Rounded barefoot edge"
          },
          {
            "code": "CPSQR",
            "name": "Square-edge",
            "note": "Crisp modern"
          },
          {
            "code": "CPCANT",
            "name": "Cantilever",
            "note": "Overhang over pool beam"
          }
        ]
      }
    ]
  },
  {
    "code": "WPRF",
    "name": "Waterproofing & Sealants",
    "unit": "SF",
    "systems": [
      {
        "code": "BELOW",
        "name": "Below-Grade / Foundation",
        "unit": "SF",
        "variants": [
          {
            "code": "BGSHEET",
            "name": "Sheet membrane",
            "note": "Self-adhered; seams are risk"
          },
          {
            "code": "BGLIQ",
            "name": "Liquid-applied",
            "note": "Seamless, conforms"
          },
          {
            "code": "BGBENT",
            "name": "Bentonite",
            "note": "Clay, self-sealing"
          },
          {
            "code": "BGCRYST",
            "name": "Crystalline",
            "note": "Cementitious, integral"
          },
          {
            "code": "BGDRAIN",
            "name": "Drainage mat",
            "note": "Dimple board protection"
          }
        ]
      },
      {
        "code": "DAMP",
        "name": "Damp-Proofing",
        "unit": "SF",
        "variants": [
          {
            "code": "DPASPH",
            "name": "Asphalt / bituminous",
            "note": "No hydrostatic pressure"
          },
          {
            "code": "DPCEMENT",
            "name": "Cementitious parge",
            "note": "Slows masonry moisture"
          }
        ]
      },
      {
        "code": "DECKCT",
        "name": "Deck / Balcony Coating",
        "unit": "SF",
        "variants": [
          {
            "code": "DKPU1",
            "name": "1-part polyurethane",
            "note": "Walkable balcony"
          },
          {
            "code": "DKPU2",
            "name": "2-part PU traffic",
            "note": "High abrasion / UV"
          },
          {
            "code": "DKURETH",
            "name": "Urethane elastomeric",
            "note": "Multi-coat (Life Deck)"
          },
          {
            "code": "DKMETAL",
            "name": "Metal-lath + slurry",
            "note": "Wood-framed balconies"
          },
          {
            "code": "DKPMMA",
            "name": "PMMA fast-cure",
            "note": "Quick return-to-service"
          }
        ]
      },
      {
        "code": "ELASTO",
        "name": "Elastomeric Roof / Wall Coat",
        "unit": "SF",
        "variants": [
          {
            "code": "ELACRYL",
            "name": "Acrylic",
            "note": "Reflective FL flat-roof recoat"
          },
          {
            "code": "ELSILIC",
            "name": "Silicone",
            "note": "Ponding + UV resistant"
          },
          {
            "code": "ELSTUCCO",
            "name": "Stucco / wall coat",
            "note": "Breathable waterproof wall"
          },
          {
            "code": "EL2COAT",
            "name": "2-coat system",
            "note": "Spec'd mil per coat"
          }
        ]
      },
      {
        "code": "JOINT",
        "name": "Sealant / Caulk Joints",
        "unit": "LF",
        "variants": [
          {
            "code": "JTPUNS",
            "name": "PU non-sag",
            "note": "Vertical joints, paintable"
          },
          {
            "code": "JTPUSL",
            "name": "PU self-leveling",
            "note": "Horizontal slab/deck"
          },
          {
            "code": "JTSIL",
            "name": "Silicone",
            "note": "Glazing, UV-stable"
          },
          {
            "code": "JTHYB",
            "name": "Hybrid (SMP)",
            "note": "Paintable + UV"
          },
          {
            "code": "JTBACKER",
            "name": "Backer rod",
            "note": "Sets joint depth"
          },
          {
            "code": "JTSANI",
            "name": "Sanitary silicone",
            "note": "Wet areas, mildew-resistant"
          }
        ]
      }
    ]
  },
  {
    "code": "FENC",
    "name": "Fencing",
    "unit": "LF",
    "systems": [
      {
        "code": "WOOD",
        "name": "Wood Fence",
        "unit": "LF",
        "variants": [
          {
            "code": "STOCKADE",
            "name": "Dog-ear stockade",
            "note": "Cheapest privacy; PT pine"
          },
          {
            "code": "BOB",
            "name": "Board-on-board",
            "note": "No gaps as wood shrinks"
          },
          {
            "code": "SHADOWBOX",
            "name": "Shadowbox",
            "note": "Good-neighbor, airflow"
          },
          {
            "code": "HORIZ",
            "name": "Horizontal plank",
            "note": "Modern, higher labor"
          },
          {
            "code": "PICKET",
            "name": "Spaced picket",
            "note": "Decorative / front-yard"
          },
          {
            "code": "RANCHRAIL",
            "name": "Ranch / split-rail",
            "note": "Acreage look"
          }
        ]
      },
      {
        "code": "VINYL",
        "name": "Vinyl / PVC",
        "unit": "LF",
        "variants": [
          {
            "code": "PRIVACY",
            "name": "Solid privacy",
            "note": "#1 FL choice vs humidity"
          },
          {
            "code": "SEMIPRIV",
            "name": "Semi-privacy",
            "note": "Airflow, wind rating"
          },
          {
            "code": "LATTICE",
            "name": "Lattice-top",
            "note": "Solid + open accent"
          },
          {
            "code": "PICKET",
            "name": "Picket",
            "note": "Open, capped"
          },
          {
            "code": "RANCHRAIL",
            "name": "Post & rail",
            "note": "2/3-rail ranch"
          }
        ]
      },
      {
        "code": "ALUM",
        "name": "Aluminum",
        "unit": "LF",
        "variants": [
          {
            "code": "FLATTOP",
            "name": "Flat-top",
            "note": "Clean modern"
          },
          {
            "code": "SPEARTOP",
            "name": "Spear / finial",
            "note": "Wrought-iron look"
          },
          {
            "code": "STAGGER",
            "name": "Staggered spear",
            "note": "Alternating heights"
          },
          {
            "code": "PUPPY",
            "name": "Puppy-picket / pet",
            "note": "Tight bottom spacing"
          },
          {
            "code": "POOL",
            "name": "Pool-code (BOCA)",
            "note": "FL pool-barrier compliant"
          }
        ]
      },
      {
        "code": "CHAIN",
        "name": "Chain-Link",
        "unit": "LF",
        "variants": [
          {
            "code": "GALV",
            "name": "Galvanized",
            "note": "Economy / utility"
          },
          {
            "code": "BLKVINYL",
            "name": "Black vinyl-coated",
            "note": "Low-visibility upgrade"
          },
          {
            "code": "GRNVINYL",
            "name": "Green vinyl-coated",
            "note": "Blends to landscape"
          }
        ]
      },
      {
        "code": "COMP",
        "name": "Composite",
        "unit": "LF",
        "variants": [
          {
            "code": "TREXSECL",
            "name": "Trex Seclusions",
            "note": "Composite privacy, no rot"
          },
          {
            "code": "SIMTEK",
            "name": "SimTek stone-look",
            "note": "Molded, wind + sound rated"
          }
        ]
      },
      {
        "code": "GATE",
        "name": "Gates",
        "unit": "EA",
        "variants": [
          {
            "code": "WALK",
            "name": "Walk / pedestrian",
            "note": "Single 3–4 ft leaf"
          },
          {
            "code": "DOUBLE",
            "name": "Double drive",
            "note": "Two-leaf opening"
          },
          {
            "code": "SLIDE",
            "name": "Rolling / cantilever",
            "note": "Driveway slide"
          },
          {
            "code": "AUTO",
            "name": "Automated operator",
            "note": "Electric + access control"
          }
        ]
      }
    ]
  },
  {
    "code": "DECK",
    "name": "Decking",
    "unit": "SF",
    "systems": [
      {
        "code": "PTWOOD",
        "name": "Pressure-Treated Wood",
        "unit": "SF",
        "variants": [
          {
            "code": "54RAD",
            "name": "5/4×6 radius-edge",
            "note": "Economy SYP board"
          },
          {
            "code": "2X6PT",
            "name": "2×6 board",
            "note": "Docks / wide joist span"
          },
          {
            "code": "MARINE",
            "name": "Marine-grade",
            "note": "Waterfront / docks"
          }
        ]
      },
      {
        "code": "COMP",
        "name": "Composite (capped)",
        "unit": "SF",
        "variants": [
          {
            "code": "TREXENH",
            "name": "Trex Enhance",
            "note": "Entry tier"
          },
          {
            "code": "TREXSEL",
            "name": "Trex Select",
            "note": "Mid tier, 35-yr"
          },
          {
            "code": "TREXTRAN",
            "name": "Trex Transcend",
            "note": "Top tier, deep grain"
          },
          {
            "code": "TREXLIN",
            "name": "Transcend Lineage",
            "note": "Heat-mitigating, cooler"
          },
          {
            "code": "TTPRO",
            "name": "TimberTech PRO/EDGE",
            "note": "PVC-capped, lighter"
          }
        ]
      },
      {
        "code": "PVC",
        "name": "Cellular PVC",
        "unit": "SF",
        "variants": [
          {
            "code": "AZEK",
            "name": "AZEK / TimberTech PVC",
            "note": "Coolest & lightest"
          },
          {
            "code": "TREXREF",
            "name": "Trex Refuge",
            "note": "Fire-resistant option"
          }
        ]
      },
      {
        "code": "HARDWD",
        "name": "Tropical Hardwood",
        "unit": "SF",
        "variants": [
          {
            "code": "IPE",
            "name": "Ipe",
            "note": "Dense, 40+ yr, premium"
          },
          {
            "code": "CUMARU",
            "name": "Cumaru",
            "note": "Ipe alternative"
          },
          {
            "code": "THERMORY",
            "name": "Thermally-modified",
            "note": "Rot/stability, lower cost"
          }
        ]
      },
      {
        "code": "ALUM",
        "name": "Aluminum Decking",
        "unit": "SF",
        "variants": [
          {
            "code": "LOCKDRY",
            "name": "Interlocking watertight",
            "note": "Keeps space below dry"
          },
          {
            "code": "OPENPLANK",
            "name": "Open-gap plank",
            "note": "Drains, fire-rated"
          }
        ]
      },
      {
        "code": "RAIL",
        "name": "Deck Railing",
        "unit": "LF",
        "variants": [
          {
            "code": "COMPRAIL",
            "name": "Composite",
            "note": "Composite/aluminum balusters"
          },
          {
            "code": "ALUMRAIL",
            "name": "Aluminum picket",
            "note": "Code-compliant, 30+ yr"
          },
          {
            "code": "CABLE",
            "name": "Cable rail",
            "note": "Open sightlines"
          },
          {
            "code": "GLASS",
            "name": "Glass panel",
            "note": "Minimalist / view"
          },
          {
            "code": "VINYLRAIL",
            "name": "Vinyl / PVC",
            "note": "Budget low-maintenance"
          },
          {
            "code": "WOODRAIL",
            "name": "Wood",
            "note": "Lowest upfront, re-seal"
          }
        ]
      }
    ]
  },
  {
    "code": "SCRN",
    "name": "Screen Enclosures & Pool Cages",
    "unit": "SF",
    "systems": [
      {
        "code": "POOLCG",
        "name": "Pool Cage / Enclosure",
        "unit": "SF",
        "variants": [
          {
            "code": "MANSARD",
            "name": "Mansard",
            "note": "Most popular FL; max height"
          },
          {
            "code": "GABLE",
            "name": "Gable / A-frame",
            "note": "Vaulted, airy"
          },
          {
            "code": "DOME",
            "name": "Dome / hip",
            "note": "Classic, budget-friendly"
          },
          {
            "code": "FLAT",
            "name": "Flat / single-slope",
            "note": "Low clearance under eave"
          },
          {
            "code": "HIPVALLEY",
            "name": "Hip-and-valley",
            "note": "Complex / wrap-around"
          },
          {
            "code": "TWOSTORY",
            "name": "Two-story",
            "note": "Ties to 2nd-floor balcony"
          }
        ]
      },
      {
        "code": "SCRNRM",
        "name": "Screen Room / Lanai",
        "unit": "SF",
        "variants": [
          {
            "code": "UNDROOF",
            "name": "Under existing roof",
            "note": "Lowest-cost conversion"
          },
          {
            "code": "PANROOF",
            "name": "Insulated pan-roof",
            "note": "New foam-core roof room"
          },
          {
            "code": "ACRYLIC",
            "name": "Acrylic 3-season",
            "note": "Convertible Florida room"
          }
        ]
      },
      {
        "code": "ENTRY",
        "name": "Entry & Specialty",
        "unit": "EA",
        "variants": [
          {
            "code": "FRONTENT",
            "name": "Front-entry",
            "note": "Screened vestibule"
          },
          {
            "code": "GARAGE",
            "name": "Garage screen",
            "note": "Roll-down / retractable"
          }
        ]
      },
      {
        "code": "RESCRN",
        "name": "Re-Screen / Repair",
        "unit": "EA",
        "variants": [
          {
            "code": "PANEL",
            "name": "Single panel",
            "note": "Per-panel screen + spline"
          },
          {
            "code": "FULLCAGE",
            "name": "Full-cage",
            "note": "Re-screen every panel"
          },
          {
            "code": "DOORSCR",
            "name": "Door re-screen",
            "note": "Screen door leaf"
          },
          {
            "code": "HARDWARE",
            "name": "Hardware / spline",
            "note": "Closers, wheels, spline"
          }
        ]
      },
      {
        "code": "MESH",
        "name": "Screen Mesh",
        "unit": "SF",
        "variants": [
          {
            "code": "18X14",
            "name": "18×14 fiberglass",
            "note": "Default; best airflow"
          },
          {
            "code": "NOSEEUM",
            "name": "20×20 no-see-um",
            "note": "Blocks tiny FL gnats"
          },
          {
            "code": "SUPER",
            "name": "Super Screen",
            "note": "Polyester, 10-yr, ~300% stronger"
          },
          {
            "code": "PET",
            "name": "Pet-resistant",
            "note": "Vinyl-coated, claw-proof"
          },
          {
            "code": "FLGLASS",
            "name": "Florida Glass",
            "note": "Laminated, waterproof/privacy"
          },
          {
            "code": "SOLAR",
            "name": "Solar / privacy",
            "note": "Blocks ~90% UV/heat"
          }
        ]
      },
      {
        "code": "ACCESS",
        "name": "Framing & Accessories",
        "unit": "EA",
        "variants": [
          {
            "code": "SUPERGUT",
            "name": "Super gutter",
            "note": "Integrated cage-to-fascia gutter"
          },
          {
            "code": "CHAIRRAIL",
            "name": "Chair rail",
            "note": "Mid-height rigidity bar"
          },
          {
            "code": "KICKPLATE",
            "name": "Kickplate",
            "note": "Solid bottom panel"
          },
          {
            "code": "PICWIN",
            "name": "Picture window",
            "note": "No-cross-member view panel"
          },
          {
            "code": "FRAMECLR",
            "name": "Frame color / gauge",
            "note": "White / bronze / black; hurricane gauge"
          }
        ]
      }
    ]
  },
  {
    "code": "WIND",
    "name": "Windows",
    "unit": "EA",
    "systems": [
      {
        "code": "IMPACT",
        "name": "Impact / Hurricane",
        "unit": "EA",
        "variants": [
          {
            "code": "SHIMP",
            "name": "Single-hung impact",
            "note": "FL best-seller"
          },
          {
            "code": "HRIMP",
            "name": "Horizontal roller impact",
            "note": "Wide masonry openings"
          },
          {
            "code": "CASEIMP",
            "name": "Casement impact",
            "note": "Near-100% ventilation"
          },
          {
            "code": "AWNGIMP",
            "name": "Awning impact",
            "note": "Sheds rain while open"
          },
          {
            "code": "PICTIMP",
            "name": "Picture / fixed impact",
            "note": "Max light / view"
          },
          {
            "code": "ARCHIMP",
            "name": "Architectural high-DP",
            "note": "HVHZ, +90/-130 PSF"
          }
        ]
      },
      {
        "code": "NONIMP",
        "name": "Non-Impact Vinyl",
        "unit": "EA",
        "variants": [
          {
            "code": "SHVIN",
            "name": "Single-hung",
            "note": "Budget; needs shutters in WBDR"
          },
          {
            "code": "DHVIN",
            "name": "Double-hung",
            "note": "Both sashes tilt"
          },
          {
            "code": "HSVIN",
            "name": "Horizontal slider",
            "note": "Wide openings"
          },
          {
            "code": "PICTVIN",
            "name": "Picture",
            "note": "Fixed, efficient"
          },
          {
            "code": "CASEVIN",
            "name": "Casement",
            "note": "Crank-out"
          }
        ]
      },
      {
        "code": "ALUM",
        "name": "Aluminum-Frame",
        "unit": "EA",
        "variants": [
          {
            "code": "SHALUM",
            "name": "Single-hung",
            "note": "Low-cost, durable"
          },
          {
            "code": "HRALUM",
            "name": "Horizontal roller",
            "note": "Legacy FL, slim sightlines"
          },
          {
            "code": "FIXALUM",
            "name": "Fixed",
            "note": "Coastal-tolerant"
          },
          {
            "code": "THERMBRK",
            "name": "Thermally-broken",
            "note": "Closes efficiency gap"
          }
        ]
      },
      {
        "code": "SPEC",
        "name": "Specialty Shapes",
        "unit": "EA",
        "variants": [
          {
            "code": "ROUNDTOP",
            "name": "Round-top / arch",
            "note": "Fixed radius-head accent"
          },
          {
            "code": "BAYBOW",
            "name": "Bay / bow",
            "note": "Projected multi-lite"
          },
          {
            "code": "OCTAGON",
            "name": "Octagon / geometric",
            "note": "Fixed decorative"
          },
          {
            "code": "GARDEN",
            "name": "Garden / greenhouse",
            "note": "Projected box, kitchen"
          }
        ]
      },
      {
        "code": "GLZ",
        "name": "Glazing & Grids",
        "unit": "EA",
        "variants": [
          {
            "code": "TINTLOWE",
            "name": "Low-E / tinted",
            "note": "Cuts FL cooling load ~30%"
          },
          {
            "code": "LAMINSUL",
            "name": "Laminated vs insulated",
            "note": "Impact vs dual-pane IG"
          },
          {
            "code": "OBSCURE",
            "name": "Obscure / privacy",
            "note": "Baths, frosted"
          },
          {
            "code": "GRIDCOL",
            "name": "Colonial grids",
            "note": "Between-glass grilles"
          },
          {
            "code": "GRIDPRA",
            "name": "Prairie grids",
            "note": "Perimeter pattern"
          },
          {
            "code": "NOGRID",
            "name": "No grid",
            "note": "Contemporary"
          }
        ]
      }
    ]
  },
  {
    "code": "DOOR",
    "name": "Doors",
    "unit": "EA",
    "systems": [
      {
        "code": "ENTRY",
        "name": "Exterior Entry",
        "unit": "EA",
        "variants": [
          {
            "code": "FGSNGL",
            "name": "Fiberglass single",
            "note": "Best FL rot resistance"
          },
          {
            "code": "STEELENT",
            "name": "Steel",
            "note": "Affordable, secure"
          },
          {
            "code": "WOODENT",
            "name": "Wood / mahogany",
            "note": "Premium, higher maintenance"
          },
          {
            "code": "DBLENTRY",
            "name": "Double",
            "note": "Wide openings"
          },
          {
            "code": "SIDELITE",
            "name": "With sidelites / transom",
            "note": "Fixed glass flanking"
          },
          {
            "code": "LITECFG",
            "name": "Lite configuration",
            "note": "Full / half / flush"
          }
        ]
      },
      {
        "code": "IMPEXT",
        "name": "Impact Exterior",
        "unit": "EA",
        "variants": [
          {
            "code": "IMPFGENT",
            "name": "Impact fiberglass entry",
            "note": "Miami-Dade NOA"
          },
          {
            "code": "IMPFRSGL",
            "name": "Impact French single",
            "note": "Laminated glass"
          },
          {
            "code": "IMPFRDBL",
            "name": "Impact French double",
            "note": "CGI / PGT lineage"
          }
        ]
      },
      {
        "code": "SGD",
        "name": "Sliding Glass / Patio",
        "unit": "EA",
        "variants": [
          {
            "code": "SGD2",
            "name": "2-panel (OX/XO)",
            "note": "One fixed, one sliding"
          },
          {
            "code": "SGD3",
            "name": "3-panel",
            "note": "Wide lanai"
          },
          {
            "code": "SGD4",
            "name": "4-panel",
            "note": "Great-room / pool"
          },
          {
            "code": "POCKETSGD",
            "name": "Pocket",
            "note": "Panels hide in wall"
          },
          {
            "code": "IMPSGD",
            "name": "Impact sliding",
            "note": "HVHZ; FL lanai standard"
          }
        ]
      },
      {
        "code": "FRENCH",
        "name": "French / Swing Patio",
        "unit": "EA",
        "variants": [
          {
            "code": "FRSNGL",
            "name": "Single",
            "note": "One hinged leaf"
          },
          {
            "code": "FRDBL",
            "name": "Double (pair)",
            "note": "Two active leaves"
          },
          {
            "code": "FROUTSW",
            "name": "Out-swing",
            "note": "FL-preferred, sheds water"
          },
          {
            "code": "FRINSW",
            "name": "In-swing",
            "note": "Traditional"
          },
          {
            "code": "FRSIDEL",
            "name": "With sidelites",
            "note": "Fixed glass flanks"
          }
        ]
      },
      {
        "code": "GARAGE",
        "name": "Garage",
        "unit": "EA",
        "variants": [
          {
            "code": "WZ3IMP",
            "name": "Wind-zone / impact",
            "note": "FL code in WBDR, ~180 mph"
          },
          {
            "code": "SECTINS",
            "name": "Insulated sectional",
            "note": "Poly core, R-value"
          },
          {
            "code": "SECTNON",
            "name": "Non-insulated",
            "note": "Single-layer budget"
          },
          {
            "code": "CARRIAGE",
            "name": "Carriage-house",
            "note": "Decorative overlay"
          },
          {
            "code": "GARSNGL",
            "name": "Single-car",
            "note": "~8–9 ft"
          },
          {
            "code": "GARDBL",
            "name": "Double-car",
            "note": "~16–18 ft"
          }
        ]
      },
      {
        "code": "INT",
        "name": "Interior",
        "unit": "EA",
        "variants": [
          {
            "code": "HOLLOW",
            "name": "Hollow-core",
            "note": "Economical"
          },
          {
            "code": "SOLIDCOR",
            "name": "Solid-core",
            "note": "Sound / quality"
          },
          {
            "code": "PREHUNG",
            "name": "Prehung unit",
            "note": "Slab hung in jamb"
          },
          {
            "code": "SLABINT",
            "name": "Slab only",
            "note": "Reuse jamb"
          },
          {
            "code": "BIFOLD",
            "name": "Bifold",
            "note": "Closets"
          },
          {
            "code": "BARN",
            "name": "Barn / sliding",
            "note": "Surface track"
          },
          {
            "code": "PANEL6",
            "name": "Panel count",
            "note": "2 / 6-panel styling"
          }
        ]
      },
      {
        "code": "STORM",
        "name": "Storm / Screen",
        "unit": "EA",
        "variants": [
          {
            "code": "FULLVIEW",
            "name": "Full-view glass",
            "note": "Interchangeable glass/screen"
          },
          {
            "code": "VENTSTORM",
            "name": "Ventilating",
            "note": "Self-storing"
          },
          {
            "code": "SECURITY",
            "name": "Security storm",
            "note": "Heavy frame + grille"
          },
          {
            "code": "RETRSCRN",
            "name": "Retractable screen",
            "note": "Roll-away"
          }
        ]
      }
    ]
  },
  {
    "code": "DRYW",
    "name": "Drywall",
    "unit": "SF",
    "systems": [
      {
        "code": "HANGFN",
        "name": "Hang & Finish",
        "unit": "SF",
        "variants": [
          {
            "code": "HALF",
            "name": "1/2\" board",
            "note": "Standard wall"
          },
          {
            "code": "FIVE8",
            "name": "5/8\" board",
            "note": "Sag-resistant ceilings / 24\" o.c."
          },
          {
            "code": "TYPEX",
            "name": "5/8\" Type-X",
            "note": "1-hr fire-rated; garages"
          },
          {
            "code": "HANGONLY",
            "name": "Hang only",
            "note": "Set + fasten, no finish"
          },
          {
            "code": "HANGL4",
            "name": "Hang + finish L4",
            "note": "Turnkey, paint-ready"
          }
        ]
      },
      {
        "code": "FINISHLV",
        "name": "Joint Finish Levels",
        "unit": "SF",
        "variants": [
          {
            "code": "L1",
            "name": "Level 1",
            "note": "Tape only; concealed"
          },
          {
            "code": "L2",
            "name": "Level 2",
            "note": "Tape + 1 coat; behind tile"
          },
          {
            "code": "L3",
            "name": "Level 3",
            "note": "2 coats; heavy texture to follow"
          },
          {
            "code": "L4",
            "name": "Level 4",
            "note": "Standard flat-paint / light texture"
          },
          {
            "code": "L5",
            "name": "Level 5",
            "note": "Full skim; smooth / gloss"
          }
        ]
      },
      {
        "code": "TEXTURE",
        "name": "Texture / Ceiling",
        "unit": "SF",
        "variants": [
          {
            "code": "KNOCKDN",
            "name": "Knockdown",
            "note": "Most common FL texture"
          },
          {
            "code": "ORNGPEEL",
            "name": "Orange-peel",
            "note": "Splatter, light–heavy"
          },
          {
            "code": "SMOOTH",
            "name": "Smooth",
            "note": "Requires Level 5"
          },
          {
            "code": "POPCORN",
            "name": "Popcorn / acoustic",
            "note": "Legacy ceiling"
          },
          {
            "code": "POPREMOV",
            "name": "Popcorn removal",
            "note": "Scrape + retexture"
          },
          {
            "code": "SKIPTROW",
            "name": "Skip-trowel",
            "note": "Hand-troweled decorative"
          }
        ]
      },
      {
        "code": "MOIST",
        "name": "Moisture / Mold-Resistant",
        "unit": "SF",
        "variants": [
          {
            "code": "GREEN12",
            "name": "1/2\" greenboard",
            "note": "Baths / laundry"
          },
          {
            "code": "GREEN58",
            "name": "5/8\" greenboard",
            "note": "Moisture + thickness"
          },
          {
            "code": "PURPLE",
            "name": "Mold-resistant",
            "note": "Fiberglass-mat board"
          },
          {
            "code": "CEMBOARD",
            "name": "Cement board",
            "note": "Wet-wall tile backer"
          },
          {
            "code": "DENSSHLD",
            "name": "Fiberglass-mat backer",
            "note": "DensShield wet areas"
          }
        ]
      },
      {
        "code": "PATCH",
        "name": "Patch & Repair",
        "unit": "SF",
        "variants": [
          {
            "code": "PATCHSM",
            "name": "Small patch",
            "note": "Nail pops / dings"
          },
          {
            "code": "WATERCUT",
            "name": "Water-damage cutout",
            "note": "Remove + retape"
          },
          {
            "code": "CRACKREP",
            "name": "Crack repair",
            "note": "Tape + refloat"
          },
          {
            "code": "ACCESSPT",
            "name": "Access-hole patch",
            "note": "After plumbing/electrical"
          },
          {
            "code": "RETEXTURE",
            "name": "Repair + retexture",
            "note": "Blend to existing"
          }
        ]
      }
    ]
  },
  {
    "code": "CARP",
    "name": "Carpentry & Framing",
    "unit": "LF",
    "systems": [
      {
        "code": "ROUGH",
        "name": "Rough Framing",
        "unit": "LF",
        "variants": [
          {
            "code": "WALL2X4",
            "name": "2×4 wall",
            "note": "Standard stud wall, 16\" o.c."
          },
          {
            "code": "WALL2X6",
            "name": "2×6 wall",
            "note": "Stiffer, R-21 cavity"
          },
          {
            "code": "PARTNON",
            "name": "Non-load partition",
            "note": "Interior divider"
          },
          {
            "code": "HEADER",
            "name": "Load-bearing / header",
            "note": "Openings + bearing walls"
          },
          {
            "code": "JOISTRAF",
            "name": "Joist / rafter",
            "note": "Roof + ceiling members"
          },
          {
            "code": "PTPLATE",
            "name": "PT bottom plate",
            "note": "Sill on FL slab (rot/termite)"
          },
          {
            "code": "BLOCKING",
            "name": "Blocking / nailers",
            "note": "Backing for fixtures"
          }
        ]
      },
      {
        "code": "SHEATH",
        "name": "Sheathing & Subfloor",
        "unit": "SF",
        "variants": [
          {
            "code": "OSBWALL",
            "name": "Wall sheathing",
            "note": "Structural skin + shear"
          },
          {
            "code": "ROOFDECK",
            "name": "Roof decking",
            "note": "Ply/OSB deck"
          },
          {
            "code": "SUBFLOOR",
            "name": "Subfloor",
            "note": "T&G over joists"
          }
        ]
      },
      {
        "code": "TRIM",
        "name": "Finish / Trim",
        "unit": "LF",
        "variants": [
          {
            "code": "BASE",
            "name": "Baseboard",
            "note": "MDF or hardwood"
          },
          {
            "code": "CASING",
            "name": "Door / window casing",
            "note": "Mitered surrounds"
          },
          {
            "code": "CROWN",
            "name": "Crown molding",
            "note": "Coped corners"
          },
          {
            "code": "CHAIR",
            "name": "Chair rail / wainscot",
            "note": "Wall accent"
          },
          {
            "code": "SHOEQTR",
            "name": "Shoe / quarter-round",
            "note": "Base transition"
          },
          {
            "code": "WINSTOOL",
            "name": "Window stool & apron",
            "note": "Interior sill"
          }
        ]
      },
      {
        "code": "SOFFIT",
        "name": "Soffit & Fascia (framing)",
        "unit": "LF",
        "variants": [
          {
            "code": "ALSOFFIT",
            "name": "Aluminum soffit",
            "note": "Vented, FL salt/humidity"
          },
          {
            "code": "VINSOFFIT",
            "name": "Vinyl soffit",
            "note": "Economical vent"
          },
          {
            "code": "PVCFAS",
            "name": "PVC / composite fascia",
            "note": "Rot-proof"
          },
          {
            "code": "WOODFAS",
            "name": "Wood fascia",
            "note": "Traditional, seal/paint"
          },
          {
            "code": "SUBFAS",
            "name": "Sub-fascia",
            "note": "Structural backing"
          },
          {
            "code": "VENTSOF",
            "name": "Vented soffit",
            "note": "Attic intake"
          }
        ]
      },
      {
        "code": "ROTREP",
        "name": "Wood Rot Repair",
        "unit": "LF",
        "variants": [
          {
            "code": "FASCROT",
            "name": "Fascia rot",
            "note": "Most common FL repair"
          },
          {
            "code": "SOFFROT",
            "name": "Soffit rot",
            "note": "Eave moisture"
          },
          {
            "code": "SISTER",
            "name": "Sister / replace",
            "note": "PT alongside failed member"
          },
          {
            "code": "JAMBROT",
            "name": "Jamb / threshold rot",
            "note": "Base of openings"
          },
          {
            "code": "SILLROT",
            "name": "Sill / subfloor rot",
            "note": "At leaks"
          },
          {
            "code": "BORATEPT",
            "name": "Borate + PT replace",
            "note": "Fungicide before re-close"
          }
        ]
      },
      {
        "code": "STAIRS",
        "name": "Stairs & Railings",
        "unit": "EA",
        "variants": [
          {
            "code": "TREADRIS",
            "name": "Treads & risers",
            "note": "Code-strict install"
          },
          {
            "code": "STRINGER",
            "name": "Stringers",
            "note": "Cut carriage supports"
          },
          {
            "code": "NEWELBAL",
            "name": "Newels & balusters",
            "note": "Guard infill"
          },
          {
            "code": "HANDRAIL",
            "name": "Handrail",
            "note": "Graspable, code height"
          },
          {
            "code": "EXTSTAIR",
            "name": "Exterior stairs",
            "note": "PT / composite for FL"
          }
        ]
      },
      {
        "code": "EXTER",
        "name": "Exterior / Structural",
        "unit": "LF",
        "variants": [
          {
            "code": "COLUMN",
            "name": "Porch / lanai columns",
            "note": "PT or wrapped posts"
          },
          {
            "code": "BEAM",
            "name": "Beams / girders",
            "note": "Load-carrying spans"
          },
          {
            "code": "DECKFRM",
            "name": "Deck framing",
            "note": "PT joists / ledger"
          },
          {
            "code": "PERGOLA",
            "name": "Pergola / arbor",
            "note": "Shade structure"
          }
        ]
      }
    ]
  },
  {
    "code": "DEMO",
    "name": "Demolition",
    "unit": "SF",
    "systems": [
      {
        "code": "INTDEMO",
        "name": "Interior Demolition",
        "unit": "SF",
        "variants": [
          {
            "code": "WALLRMV",
            "name": "Wall / drywall removal",
            "note": "Strip to studs"
          },
          {
            "code": "FLOORTO",
            "name": "Flooring tear-out",
            "note": "Tile/carpet/wood + underlayment"
          },
          {
            "code": "CEILRMV",
            "name": "Ceiling removal",
            "note": "Drywall / popcorn"
          },
          {
            "code": "FIXTRMV",
            "name": "Cabinet / fixture removal",
            "note": "Vanities, tubs, appliances"
          },
          {
            "code": "KBSTRIP",
            "name": "Kitchen / bath strip-out",
            "note": "Full room gut"
          },
          {
            "code": "FULLGUT",
            "name": "Full interior gut",
            "note": "Strip to shell"
          }
        ]
      },
      {
        "code": "SELECT",
        "name": "Selective / Structural",
        "unit": "SF",
        "variants": [
          {
            "code": "NONLOAD",
            "name": "Non-load partition",
            "note": "No shoring"
          },
          {
            "code": "LOADBEAR",
            "name": "Load-bearing removal",
            "note": "Temp shore + beam"
          },
          {
            "code": "OPENCUT",
            "name": "New opening cut",
            "note": "Window / door in wall"
          },
          {
            "code": "ENLARGE",
            "name": "Opening enlargement",
            "note": "Widen for SGD"
          },
          {
            "code": "SOFFRMV",
            "name": "Soffit / bulkhead",
            "note": "Interior drops"
          }
        ]
      },
      {
        "code": "EXTDEMO",
        "name": "Exterior Demolition",
        "unit": "SF",
        "variants": [
          {
            "code": "SIDINGRMV",
            "name": "Siding removal",
            "note": "Strip cladding"
          },
          {
            "code": "STUCCORMV",
            "name": "Stucco removal",
            "note": "To lath"
          },
          {
            "code": "EXTUNIT",
            "name": "Window / door removal",
            "note": "For replacement"
          },
          {
            "code": "LANAIRMV",
            "name": "Screen / lanai removal",
            "note": "Enclosure teardown"
          }
        ]
      },
      {
        "code": "ROOFTO",
        "name": "Roof Tear-Off",
        "unit": "SF",
        "variants": [
          {
            "code": "SHNGL1",
            "name": "Shingle 1-layer",
            "note": "Strip to deck"
          },
          {
            "code": "SHNGL2",
            "name": "Shingle 2-layer",
            "note": "Added labor"
          },
          {
            "code": "TILETO",
            "name": "Tile tear-off",
            "note": "Heavy concrete/clay"
          },
          {
            "code": "DRYIN",
            "name": "Deck exposure / dry-in",
            "note": "Inspect + temp cover"
          },
          {
            "code": "FLATRMV",
            "name": "Flat / modified removal",
            "note": "BUR / mod-bit strip"
          }
        ]
      },
      {
        "code": "CONCRMV",
        "name": "Concrete / Flatwork Removal",
        "unit": "SF",
        "variants": [
          {
            "code": "SLABBRK",
            "name": "Slab break-out",
            "note": "Interior/exterior slab"
          },
          {
            "code": "DRIVERMV",
            "name": "Driveway / sidewalk",
            "note": "Flatwork removal"
          },
          {
            "code": "PATIORMV",
            "name": "Patio removal",
            "note": "Rear slab"
          },
          {
            "code": "FOOTER",
            "name": "Footer / foundation",
            "note": "Structural"
          },
          {
            "code": "SAWCUT",
            "name": "Saw-cut",
            "note": "Clean cut before removal"
          }
        ]
      },
      {
        "code": "HAUL",
        "name": "Debris Haul & Disposal",
        "unit": "EA",
        "variants": [
          {
            "code": "DUMP20",
            "name": "20-yd dumpster",
            "note": "Mid-size C&D"
          },
          {
            "code": "DUMP30",
            "name": "30-yd dumpster",
            "note": "Large gut / tear-off"
          },
          {
            "code": "HAULDUMP",
            "name": "Haul-off + dump fees",
            "note": "Transport + tipping"
          },
          {
            "code": "CDRECYC",
            "name": "C&D recycling",
            "note": "Sort / divert"
          },
          {
            "code": "LOADOUT",
            "name": "Load-out labor",
            "note": "Hand-carry to container"
          }
        ]
      }
    ]
  }
];
