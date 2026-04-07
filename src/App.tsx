import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import hatchLogo from "../hatch_logo.png";

interface Message {
  role: 'user' | 'ai';
  content: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: (event: any) => void;
  onerror: (event: any) => void;
  onend: () => void;
}

const RAW_PROJECTS = [
    "H-370104 RTA-AP60 Smelter Expansion", "H-366122 Integrated Lithium Project", "H-369146 JS2 Execution Engineering Services", 
    "H-376032 Windfall FS Study Management Consultant", "H-373719 Cameco EMBARK Project", "H-376337 Stibnite Gold Project", 
    "H-375044 New Micromill PCM Execution Phase", "H-375541 KL Program", "H-366551 Nolans Rare Earths Project", 
    "H-375270 BHP OD SCM27", "H-024810 Atlantic Copper - Circular", "H-375231 OD-SRE", "H-302412 TECHNOLOGIES - ADMIN", 
    "H-372486 Hermosa - Taylor Process Plant E&P", "H-375154 Lumwana Expansion Project", "H-375000 Jansen Stage 1 - EPCM HB JV", 
    "H-368092 USA RE Magnet Facility FEL2/3", "H-302083 INTERNAL FINANCE", "H-373068 PTFMR Commissioning Management - Exec", 
    "H-376461 Gary 84\" HSM API Implementation", "H-376621 Impala F4 Reline Engineering", "H-300629 Health & Safety Indirect", 
    "H-302040 INTERNAL IT Project", "H-375296 RTA - Laterriere Tailing Project", "H-375946 NeoSmelt ESF Pilot Feasibility", 
    "H-373373 Phase 2 - Fermeture Progressive d'Arvida", "H-302084 INTERNAL HUMAN RESOURCES", "H-366614 Rook I Project - FEED", 
    "H-377059 Willow Rock Energy Storage Center", "H-369140 Furnace Operations Support - MSA", "H-370751 EES - Platform Development", 
    "H-376521 Mt Holly PL2E FEL 4 - Execution", "H-372941 IOC - Dumper No.3", "H-302082 INTERNAL SHARED SERVICES", 
    "H-353100 Onaping Depth FEL4", "H-372899 Mactaquac Owner's Engineer", "H-376878 Sonatrach - FEED for Greenfield Complex", 
    "H-377266 New Continuous Caster for EC Rod Product", "H-373909 Vopak Victoria Energy Terminal Project", 
    "H-376794 FEL1 of Project Crucible", "H-300651 Pyrometallurgy Practice Indirect", "H-374109 Whabouchi Mine - Execution services", 
    "H-300330 EP&P - Indirect", "H-376717 Marinus Link - BoW Delivery Phase Design", "H-364159 Sishen Koketso Project", 
    "H-375370 PTFI Grasberg Mining Complex Simulation", "H-377071 Lone Tree Autoclave Restart - Execution", 
    "H-300536 Mechanical Indirect", "H-371959 GCO Phase 2 Expansion - Execution", 
    "H-024852 TBRC Band-und Bunkeranlage f?r das CRH-P", "H-300331 Vehicles & Operations Indirect", 
    "H-376592 Port Pirie Critical Minerals rebuild PFS", "H-300537 Structural Indirect", "H-302106 ET SYS DEV", 
    "H-376475 Aclara Carina REE Feasibility Study", "H-373313 Cadia Proj Integration & Tailings Infra", 
    "H-300655 Mining Practice Indirect", "H-376311 USS Mon Valley Hot Strip Mill FEL2", 
    "H-373216 Zimplats Technical Site Support (Stage 2", "H-300533 Electrical Indirect", 
    "H-375620 MX-East Harbour Transit Hub Alliance PAA", "H-353960 Annacis WWTP Outfall - CM", 
    "H-300724 Project Commercial Management Indirect", "H-300103 Consulting BD & Indirect", "H-359516 Lakeshore WPCP Expansion", 
    "H-369479 KSR", "H-376465 SSA New Manzanillo FEL 3 - Phase 1", "H-300535 Control and Automation Eng. Indirect", 
    "H-300621 Project Controls Indirect", "H-305412 TECHNOLOGY BUSINESS DEVELOPMENT", "H-372943 EHMP Phase 5 Au-C POX Plant FEL4", 
    "H-355608 REM - CIMA+/HATCH Coenterprise-Phase II", "H-300322 Transit Indirect", "H-369538 SCA Discharge Project - Detailed Design", 
    "H-376323 Neosmelt PMC", "H-300601 Advisory Indirect", "H-300654 Hydrometallurgy Practice Indirect", 
    "H-363270 Réfection majeure tunnel L-H-La Fontaine", "H-370446 Onca Puma Furnace 2 FEL 4", 
    "H-374343 PRC - Potasio Rio Colorado ? Basic Eng.", "H-300660 Commercial Practice Indirect", "H-376325 NeoSmelt Balance of Plant", 
    "H-376512 Zuuvch-Ovoo Uranium Project", "H-377352 TCM Restart S2/S3 Commissioning Services", "H-376658 Chavimochic - Phases 3-5", 
    "H-376914 Viridis Colossus Project DFS", "H-300303 E&S Indirect", "H-300411 Oil & Gas Indirect-old", "H-300631 Quality Indirect", 
    "H-365849 MMR Detailed Engineering", "H-300680 Climate Change Indirect", "H-370175 Project Trilogy FEL 2", 
    "H-376811 GBC Business Recovery Support", "H-300037 INDIRECT CIVIL / STRUCT / ARCH", "H-367584 CSC Infrastructure Design", 
    "H-370132 MX - EHTH Alliance Development Phase", "H-373109 General Electric - CER1 LCC EP1", 
    "H-377291 New Vertimill Detailed engineering", "H-368368 MSA 3037681 - HUB Caribe Reficar Coke Ex", 
    "H-374352 EES Demonstration Plant", "H-376958 Ingenier?a FEL3 Lixiviaci?n Clorurada RT", 
    "H-300657 Project Development Practice Indirect", "H-300659 Tailings Practice Indirect", 
    "H-301654 Education/Learning-Hydrometallurgy", "H-359514 Confederation Line Extension (OttawaLRT)", 
    "H-374069 ID, Adq. e Ing Resid Proy LSTS WP05/SP02", "H-375926 DNNP Subsequent Units Enhanced Modulariz", 
    "H-301133 PDG - Construction Mgmt", "H-376501 IORC Freeport McMoRan Integrated Remote", "H-377250 Bagdad PLS", 
    "H-300632 Risk Indirect", "H-303100 PDG DPD Program", "H-361242 CCSJV Env. Monitoring Services (Moz)", 
    "H-366181 Winnipeg NEWPCC Execution", "H-371909 Flotation Integrity Project", 
    "H-376681 ERA - Engineering Services for Decommiss", "H-300327 Tunneling Indirect", "H-300624 Procurement Indirect", 
    "H-305319 Business Development - Water", "H-370145 Programme ?lectrique sous-station et SF", "H-372842 Ageli PFS", 
    "H-374590 McCormick ?tude Projet Modernisation ?va", "H-376439 VZI - Gamsberg Phase 2 OR Programme", 
    "H-300622 Project Management Indirect", "H-354899 Annacis Water Supply Tunnel Eng Svcs", 
    "H-373121 Vianode - New Synthetic Graphite Large S", "H-376018 NWMO IPD - Category 6 (Nuclear Systems)", 
    "H-376831 ONTC WOP 1034 - TC Fuel Tank Regulation", "H-305420 Water Power Business Development", 
    "H-370675 Vale Overflow Engineering - EPCM", "H-374250 Worsley BOD Project FS", "H-374437 Sparrows Point Container Terminal", 
    "H-374662 GCO Phase 2 Expansion - Execution: Const", "H-376774 Cariboo Gold - EP", "H-377146 Magnet Plant P2/3/4 PFS", 
    "H- FMR Freeport Maynar Consolidated", "H-300431 eGrid Indirect", "H-300545 Engineering Management Indirect", 
    "H-370703 ALC - ASU in Becancour", "H-372223 5543 CTDOT New Coaches Base Order", "H-374525 IB Continuidad Nivel 1 - PMCHS", 
    "H-376262 MSO Churchill Falls Powerhouse ? Enginee", "H-300150 CORE Indirect", "H-300623 Construction Indirect", 
    "H-305432 Nuclear BD", "H-375456 ABI00008_P_BF_ABF#2 Refractory Relining", "H-376057 White Springs - Transformation", 
    "H-376636 Qatalum Larger Anode Project FEL-4", "H-377169 Chase Field 2025/2026 Rope Replacement", 
    "H-377275 Alcoa - ADQ Fluewall Replacement and Rai", "H-264910 SCRRA Eng and Tech Suppor", "H-300543 Information Management", 
    "H-305417 Base Metals Business Development", "H-366690 Miami Smelter Optimization Project (MSO)", 
    "H-367118 FoM ACP Debottlenecking", "H-370913 Pont de l'Ile aux Tourtes - Design", 
    "H-373003 BHP MSA Portfolio 2023-27 JS Secondments", "H-373058 Aurubis Hamburg - TK2Neo Design-Supply", "H-374376 Heat Pipes", 
    "H-375187 Dust-HVAC Assessment and Feasibility Eng", "H-375982 CN Zanardi Construction Skeena M87.2", "H-376269 CCUS Hub Study", 
    "H-376808 Bayside Phase 2 Expansion", "H-376858 Cat Arm Unit 3 Feasibility Study", 
    "H-377143 TSF2 Embankment Raise to RL 69m - Site", "H-377270 BF1 & BF2 Campaign Life Assessment Upd.", 
    "H-377381 RE Refinery DFS Ramp-up", "H-377393 Nyrstar Side Leach PFS", "H-300022 INDIRECT P&CM - PROJECT MANAGEMENT", 
    "H-300062 PDG Business Development", "H-300652 Ind. Clean Tech Practice Indirect", 
    "H-305601 Advisory - Investment & Bus Planning BD", "H-361955 Pattullo", "H-369998 South Airport Cargo Development", 
    "H-372339 6333 SEPTA M-4 Support", "H-374635 NEWPCC- Biosolids Facilities - EPD", "H-374860 EMME - Battery Sulphates Plant FEL3", 
    "H-375063 TCM EPCM (EP Phase)", "H-375141 APS Zimplats Spare Parts", "H-375897 Usure excessive du convoyeur d'alumine n", 
    "H-375998 Greenbushes Operations - Asset Managemen", "H-377216 Northern Water Supply Project Tender Des", 
    "H-377243 FEL2B - BFP Project", "H- Alcoa NE Alliance", "H-115739 Engcobo Ext", "H-300432 Nuclear Indirect", 
    "H-302103 CLient Action Team", "H-305219 Minerals Business Development", "H-305418 Bulk Metals Business Development", 
    "H-346175 N7 Upgrading at Vissershok", "H-366083 Gove Pond 5 Construction Support", 
    "H-367589 Tarquti Nunavik Renewable Power Projects", "H-375354 Santa Rita UG Mine FEL 3", 
    "H-376009 Construction d'un b?timent de service de", "H-376241 TPT ECM - Port of Saldanha", 
    "H-376925 VB Productive Capacity Increase PFS", "H-377296 Alcoa - (ABI00346) ABF #1 Reline", "H-264190 CT DOT- Eng. & Inspection", 
    "H-300320 Rail Indirect", "H-300326 Rail Systems Indirect", "H-300656 Mineral Processing Practice Indirect", 
    "H-305214 Light Metals Business Development", "H-347691 R22 Elimination of At-grade Railway Cros", 
    "H-355802 Melbourne Metro Independent Reviewer", "H-364822 Zimplats Smelter and SO2 Abatement", 
    "H-365911 X-Energy NRE Preliminary Design Support", "H-366295 TMRSM028 Bridge Assessment - Secondment", 
    "H-372652 2024 Teck Metals MSA Projects", "H-374463 Neptune B2D2 Project", "H-374688 Secondary Crusher Expansion", 
    "H-375907 Cadia Tailings STSFX BR Strategy and Est", "H-376216 Eolian Energy Smelter Concept Study", 
    "H-376597 PFS - Brook Mine Rare Earth Project", "H-376663 Slurry Dust Return System - Phase 1", 
    "H-377248 2026 Teck Metals MSA Projects", "H-377444 Fermeture du circuit de broyage U/G", "H-265005 NYCT R211 Car Procurement", 
    "H-300323 Aviation Indirect", "H-300343 Geotechnical Indirect", "H-300420 Energy", "H-301131 PDG - Project Controls", 
    "H-302087 INTERNAL EXECUTIVE", "H-305325 Business Development - Defence", "H-366162 Zero Carbon Lithium Definitive FS", 
    "H-370295 HONI Joint Use Review Program", "H-372840 SF4 Furnace Rebuild Engineering", 
    "H-373740 Ingenier?a Estudio Fase Selecci?n (SPS)", "H-374621 OR & Commissioning Plan Marcobre Undergr", 
    "H-376445 New Iron Ore & Pelletizing Facility PFS", "H-377106 3-D Model for Guthega Hydropower Station", 
    "H-377402 Copper DD Argentina", "H-377431 Hamilton LRT - Civil & Utilities", "H-377607 Donlin Gold POX/O2 FEED", 
    "H- 357829P - Portage Pea Project", "H-300539 Piping Indirect", "H-300630 Document Control Indirect", 
    "H-301533 Electrical Education & Training", "H-369592 IC Desarrollo Post. Akacias Guamal", 
    "H-371132 Kings Mountain Bridging to FEL 3", "H-373322 Thickener Optimization", "H-373436 Zimplats Technical Site Support (Site)", 
    "H-374136 PWSA - Lime Slurry", "H-375572 K+S Potash Canada 2025 Projects", 
    "H-376167 DNNP - DPSC Secondment of Drafting Suppo", "H-376673 CW EMD - Echo Point Facility FEL2", "H-376697 OPSP - FEL 2+", 
    "H-377053 JPMe Conceptual Studies", "H-377130 Alfalfal II and Las Lajas T&C Support", 
    "H-377260 TMC - US Onshore Smelter PFS Refresh", "H-377306 UO2 Process Study for Ammonium Hydroxide", 
    "H-377366 Raglan Wind Power Scoping 3.0", "H-377454 FEL3 - Jameson Cell Installation", "H-300023 INDIRECT P&CM - CONSTRUCTION", 
    "H-300328 Management & Delivery Indirect", "H-300546 Architecture Indirect", "H-360498 Contrato Marco Ing. Mayores DRT", 
    "H-366172 Nataka Pre-Fesibility Study", "H-373255 Nu-West CPO Compliance Projects", "H-374430 Alcoa Wagerup RSA10 - FEL3", 
    "H-374978 Water Pipeline to Milagro Plant", "H-375156 Boston Metal 300kA Basic", "H-376536 Jwaneng Underground - PFSB Study - ENG", 
    "H-377080 Nutrien - Aurora - Phos Acid - Phase 1", "H-377095 Smoky Creek & Guthrie's Gap - ECI Design", 
    "H-377189 PFS C?t? Gold Mill Expansion", "H-377232 Green Line LRT Downtown Functional Plan", 
    "H-377233 Jimblebar Dual TLO Upgrade EXE Phase", "H-377452 #2FF Cooler/Refractory QA & Inspections", 
    "H-377479 PLANIF. Y COMISIONADO IN-PIT TSF", "H- Global Construction Projects", "H-300548 Geotechnical Indirect", 
    "H-337520 Expansion of Hwange Power Plant", "H-357652 Technology Spare Parts Inventory", "H-363486 TransLink 193029-03 SkyTrain OMC4", 
    "H-368525 Mise ? jour devis normalis? tuyauterie", "H-369264 Begbie's Preferred Vendor Agreement-ZAR", 
    "H-372049 AAI - C00865 Rehausse des fours 3 et 4 -", "H-372058 6087 SEPTA - New Streetcar Engineering S", 
    "H-373113 OPG Kakabeka Life Extension", "H-373336 Transition ?nerg?tique IDLM", "H-374538 Manhattan Cruise Terminal Master Plan", 
    "H-374827 Hunter Power Plant - Commissioning Suppo", "H-375261 LTFT - HTFT Phase 2", 
    "H-376328 Bruce Hwy Walker St Intersection Upgrade", "H-376520 Peer Review OR - Proj Itabiritos", 
    "H-376637 PTP - Impala Furnace Operations Support", "H-376848 Beta - Dugong Co-Development Update", 
    "H-377050 Aclara REE Separation Plant US Basic Eng", "H-377267 EAF Slag Water Granulation Concept Engin", 
    "H-377379 Wet Way Process Engineering Study", "H-377437 Nova Sustainable Fuels Marine Terminal", 
    "H-377504 Drill and blast ROM Fragmentation Opt", "H-024808 EMSR KVA Delfzijl (DEL4)", "H-372709 KL Fixed Facil's BEng", 
    "H-373931 CORE Support for Iluka Balranald Project", "H-374058 Construction Mangt. Jamalco STG4", 
    "H-375235 Gestion ?quipe Construction Hatch 2025", "H-375759 SL3 Replacement Project - DPS and EXE", 
    "H-376176 P060178 Upgrade Engineering Services", "H-376371 Chemchemal Extended Well Test Detailed E", 
    "H-376672 BASF REE Magnet Recycling Options Study", "H-377079 BIM - 22Mpta via South Steensby Project", 
    "H-377279 Investigation of Road Access and Modular", "H-377280 Lone Tree Restart - CDE Program", "H-377562 Kemess Infrastructure PFS", 
    "H-263433 PATH- Railcar & Signal", "H-353906 Regional Express Rail (RER) Package 1", 
    "H-368519 PTA of WA C Series EMU Rolling Stock Qua", "H-370312 Williams Parkway Watermain", 
    "H-372207 EGP - Construction Management - Tunnel", "H-372727 Programme fuites d'eau", "H-373785 RTFT - RF", 
    "H-373982 TSF2 R5 Site Invest. Causeway DD & Lab", "H-374284 Snowy Hydro Hunter Protection Engineer", 
    "H-375307 Net zero roadmap - Codelco", "H-375503 Nutrien Projects Portfolio 2025-Ops", "H-375869 PWSA - 2023 SDWMR", 
    "H-376402 Freeport MicroGrid Controls + BESS", "H-376479 Process Engineering ? Transition Project", 
    "H-376699 CISDI UK - Tata Steel UK Coilbox Replace", "H-376898 Condensate Crossover Line ISP & KM250", 
    "H-376945 Regional Rail Project Fleet TA", "H-376972 Proy. Desarrollo Car?n", "H-377041 Zimplats F2 Performance Support FY25-26", 
    "H-377070 Stack Study for Radon Dispersion from Mi", "H-377325 Commissioning Planning and workforce eng", 
    "H-377330 Geotechnical Investigation of Vale BT16", "H-377354 Am?lioration de la section planage", 
    "H-377405 Tanduringie Creek Bridge Upgrade", "H-377500 Evaluacion Tecnica plan de desmantelamie", 
    "H-377603 Chevron Lithium Project - Pilot Plant Sc", "H-300342 Hydrotechnical Indirect", "H-300661 Simulation Practice Indirect", 
    "H-316117 Planning & Project Controller", "H-362025 Jadar FS", "H-362658 H362658 - Programme de Fours", 
    "H-366308 Big Eddy and Agnew Lake EOR", "H-366615 Green Line LRT Project", "H-370017 Estudio para la optimizacion del proceso", 
    "H-372592 Digues Beauharnois-Travaux prioritaires", "H-373289 Lester Kropp Bridge", "H-373908 CS Energy - Secondments", 
    "H-374512 HMGP Fire Protection 2025", "H-374571 Owner's Engineer for Trailroad Battery E", "H-374704 Spruce River Dam Safety Upgrades", 
    "H-375138 R262/R268 New Railcar Procurement - LNTP", "H-375143 BCH WRCS MSA - LDR - Implementation", 
    "H-375961 JR Simplot - Pipeline Capacity Expansion", "H-376141 Expansi?n Botadero de Ripios Fase X DGM", 
    "H-376223 ALCOSAN Retained Engineer - Misc Small P", "H-376273 Oakmont WWTP Upgrades - Construct. Phase", 
    "H-376751 Sino Iron TSF3 Tender Design", "H-376762 ENGINEERING AND CONSULTANT SERVICES FOR", 
    "H-376806 Steelscape Kalama-Blower Control Upgrade", "H-376866 Newfoundland and Labrador Hydro Battery", 
    "H-376891 Wet Process FEL2 Study", "H-377032 Pier 400 Electrification Feasibility", 
    "H-377090 Oklo - Aurora Used Core Assembly Storage", "H-377119 Manitoba Hydro 600 MW CT FEED Study", 
    "H-377132 Mosaic - Ona-Prewash & Screening Station", "H-377151 Strange Lake Refinery Residue PFS Update", 
    "H-377286 Battery Recycle DD", "H-377313 ATA Creep", "H-377318 ID Tratamiento Residuos Filtrados", 
    "H-377338 Catastrophic Risk Assurance Program 2026", "H-377350 Mt Milligan Feasibility Study Eng'g", 
    "H-377424 QMM WCP Upgrades - FEED Engineering", "H-377458 Evaluation of bauxite and alumina supply", 
    "H-377481 Maaden Elevate - PMO - Early Works Packa", "H-377515 Mine-to-Process Optimisation Greenbushes", 
    "H-377593 PH Tailings Capacity Replacement IPS", "H- 348883 EXCLUDE CONTRACTOR HOURS Constellium EPCM Alliance", 
    "H- TiO4 Program - Canada", "H-264550 LIRR/MNR PostAwrd Sup", "H-295030 Technologies", "H-295555 CRISP+", 
    "H-300124 INDIRECT PROCUREMENT-ENERGY", "H-300242 Risk - Indirect Project", "H-300319 Water Indirect", 
    "H-300321 Ports & Terminals Indirect", "H-301100 PDG - Global Safety", "H-301536 Mechanical Education & Training", 
    "H-301651 Education/Learning-Pyrometallurgy", "H-326000 AP60 - Phase 1", "H-351362 Burnhamthorpe Road Watermain", 
    "H-365948 COMILOG IROC Building", "H-367314 IBP - Independent Technical Advisor", "H-367431 Kemerton Expansion Project", 
    "H-368002 Gove Refinery Closure - Detailed Design", "H-368673 R?fection des caissons 501 ? 508 du CDS", 
    "H-370318 Off-Gas Managem - Glencore Horne Smelter", "H-370571 JD Irving-Brighton Mountain Wind Farm", 
    "H-372938 Jimblebar - Dual Bin TLO Replacement - D", "H-373208 Remplacement des groupes 6 et 7", 
    "H-373303 MLAP - Hatch JV Admin Effort", "H-373610 6158 LA Metro - HR5000 Heavy Rail Projec", 
    "H-373713 Brisbane Cross River Rail - CPS", "H-373824 Ertis HMP - Custom Equipment Supply", 
    "H-373862 USS Great Lakes Work Pickle Line Upgrade", "H-374403 BRDA 5 Decant Pond Infrastructure PFS", 
    "H-374419 REE Recovery from Coal Based Sources FS", "H-374472 Spodumene to LHM PFS", "H-374655 GISTM for Nexa", 
    "H-375291 Mosaic - Riverview - Evaporator #7 & #8", "H-375455 Cameco Assigned Resources - Miscellaneou", 
    "H-375591 ABI00217_OPP. INC. EE by Incr. AnodeSize", "H-375626 Simplot RS Granulation FEL2/FEL3 Upgrade", 
    "H-375696 DLE Greenfield Scoping Study", "H-375699 ANSTO Radiological Waste Disposal Pathwa", 
    "H-375750 18313-0C No 2 FF Major Rebuild PMP FEL3", "H-375842 HHT 2025 Capital Works Projects", 
    "H-376062 Sea Island Renewable Energy", "H-376090 CLP 1.5", "H-376101 FEED for Mahalo Water Management", 
    "H-376331 PWSA - 2025 Urgent Water- IEI", "H-376500 Port Hope Emergency Ventilation Study", 
    "H-376530 Traction Substation Feasibility Study -", "H-376711 Phoenix Tailings RE Refinery Engineering", 
    "H-376741 Development of Asset Integrity Documents", "H-376796 Turbine Foundation Design", 
    "H-376903 Northam F1 Upgrade Basic Engineering", "H-376920 Antamina F9C Soporte Ing. Detalle", 
    "H-376953 Waterloo Hydro. - Greaseless Conversion", "H-376966 Air Pollution Control Analysis and Re-De", 
    "H-376985 Iluka Eneabba RE Refinery Commissioning", "H-377088 Projeto PET - Opera??o Norte", 
    "H-377109 BMA Peak Downs - Tailings Pipeline Asses", "H-377125 CBC Scale-Up", "H-377212 H2OK Asset Preservation", 
    "H-377225 USSteel Gary -BFG and NG Optimization", "H-377398 High-level Review of IAA Operations", 
    "H-377412 IB Dirty Air Duct - Detailed Design Post", "H-377503 DRI Transport Assessment ? Phase 2", 
    "H-377534 Nyrstar Hobart Clean Jarosite - PFS", "H-377545 Project Isthmus - Panama DD"
];

const PROJECTS_LIST = ["Hatch Global (Project View)", ...RAW_PROJECTS.filter(p => p !== "Hatch Global (Project View)").sort()];

const CITIES_LIST = [
    "Mississauga", "Montreal", "Johannesburg", "Jonquiere, Saguenay", "Brisbane", "Santiago", "Medellin", "Gurugram", "Vancouver", 
    "Essen", "Belo Horizonte", "Calgary", "Pittsburgh", "Sudbury", "Saskatoon", "Trois-Rivieres", "Perth", "Saguenay", "Lima", 
    "Houston", "Ambler", "Niagara Falls", "St. John's", "Abu Dhabi", "Los Angeles", "Melbourne", "London", "Jakarta", "Tampa", 
    "Brooklyn", "Winnipeg", "Katowice", "Solwezi", "Chicago", "Cape Town", "Sydney", "Tracy", "Bogota", "Markham", "Boston", 
    "Seattle", "Halifax", "Newcastle", "Adelaide", "Salt Lake City", "Thunder Bay", "Fredericton", "Trail", "Mojave Micro Mill", 
    "Sydney (NS)", "Durban", "Columbus", "Duren", "Dallas", "Denver", "Shanghai", "Washington, DC", "Edmonton", "Minneapolis", 
    "Newark", "East London", "Beijing", "Gaborone", "Calama", "Wollongong", "White River Junction", "Atlanta", "Al Jubail", 
    "Indonesia (Hatch Australia-Asia)", "Oakland", "United States of America (USA)", "Rochester", 
    "Africa (Hatch Africa, India & Middle East)", "Oakville", "Charlotte", "Kitimat", "Ourilândia do Norte", "Western Canada (WCA)", 
    "Maputo", "Portland", "Europe (EUR)", "Australia (Hatch Australia-Asia)", "Eastern Canada (ECA)", "Antofagasta", "Greenbelt", 
    "Peru (Hatch Latin America)", "Baie-Comeau", "Europe (Hatch Europe)", "Amherst", "Hatch Africa, India & Middle East (AIM)", 
    "Hatch Global", "New Haven", "Montreal GDC", "St John's", "Alstom Sahagun Mexico", "Harare", "Toronto", "Brisbane GDC", 
    "Sao Paulo", "El Estor", "Jubail", "Mexico City", "Hamilton", "Mississauga GDC", "Santiago GDC", "Brazil (Hatch Brazil)", 
    "Canada (Hatch Western North America)", "Chile (Hatch Latin America)", "Gladstone", "Hatch South America (SAM)", "Montana", 
    "New York City", "Rio de Janeiro", "Sao Luis", "St John's OC"
].sort();

const STREETS_LIST = [
    "2800 Speakman Drive", "AP60 Site", "5 Place Ville Marie Montreal", "2699 Speakman Drive, Mississauga, Ontario, L5K 1B1", 
    "58 Emerald Parkway Road, Greenstone Hill", "Edificio FIC48 Carrera 48 #18A-14, Medellin, Colombia", "Nemaska, Becancour", 
    "Home Office", "1066 West Hastings Street, Suite 400", "61 Petrie Terrace Barracks", "Belo Horizonte Office", 
    "1000-707 8th Avenue SW Calgary", "500 Avda. El Bosque Norte, Piso 12, Las Condes, Santiago 755-0092", 
    "Brisbane Corporate Office", "2265 Upper Middle Road (Westbury)", "Gurugram", "375 North Shore Dr., Pittsburgh PA", 
    "Level 1, 197 St Georges Terrace, Perth", "2333 Regent Street S, Sudbury, Ontario P3E 6K7", "Essen Office (Germany)", 
    "Office or Site not in list", "201 - 121 Research Drive, Saskatoon", "Av. Conquistadores 626 - Ofic. 301, San Isidro, Lima", 
    "750 Town and Country Blvd. 6th & 5th Floor", "Greenstone Office, Johannesburg", "4342 Queen Street, Niagara Falls , Suite 300", 
    "100 West Butler Avenue 1st and 2nd floors", "Atlantic Copper CirCular Project, Huelva", 
    "Tower A, Building No 9, 1st Floor, DLF Cyber City, Gurgaon, Haryana 122002", "2265 Upper Middle Road - Suite 300", 
    "2599 Speakman Drive", "Abu Dhabi", "Av. El Bosque Norte 500 Piso 6", "Lumwana Expansion Project Site", 
    "4th Floor, 20 St. Andrew Street, London, EC4A 3AG", "Gurgaon Office", "3611 Queen Palm Drive, Tampa", 
    "Katowice Office (Poland)", "Av. El  Bosque Norte 500 Piso 5", "Level 5,360 Collins Street", 
    "601 South Figueroa St. Suite 4300", "335 Adams Street, #2700, Brooklyn NY", "15 Allstate Parkway, Suite 300, Markham", 
    "80 Hebron Way, Ste100, St. John's", "330 St. Mary Avenue - Unit 500, Winnipeg", "Jakarta Office", "Jansen Site", 
    "50 Carrington St, Sydney", "425 South Financial Place, Ste 3025", 
    "Edificio TInkko Ecoteck Calle 99 # 10-57 3th Floor, Bogota, Colombia", "1201 Third Avenue, Suite 850, Seattle WA 98101", 
    "260 Franklin St, Boston", "Impala Smelter", "45 Hebron Way, Suite 101 St. John's", "Onaping Depth Project", "RTA Arvida", 
    "Av. Bosque Norte Piso 13", "Mojave MicroMill", "PTFI Grasberg", "973 Balmoral St, Thunder Bay", "Gold Fields Site", 
    "Halifax, Nova Scotia", "520 King St #850, Fredericton, NB, E3B 6G3", "Fenix Electric Furnace Site", 
    "1350, chemin Saint?Roch, suite 200, Sorel?Tracy", "510-170 South Main Street", "Gold Fields Office", "Av. Bosque Norte Piso 12", 
    "Cameco EMBARK – Key Lake", "Cape Town", "Greenstone Hill", "EHTH Alliance Office - 415 Eastern Avenue, Toronto", 
    "1303 Bay Avenue, Trail, BC", "GCO Expansion Phase 2", "3200 Boulevard St. Louis, Sorel-Tracy, QC", "47 Darby St, Cooks Hill", 
    "182 Victoria Square, Adelaide", "Pacific Steel Group (PSG)", "Düren Duren Office (Germany)", "Sishen Koketso Project", 
    "Integrated Lithium Project", "Trois-Rivière office", "88 East Broad Street, Suite 1980, Columbus, OH", " + 43% Kumba Upgrade", 
    "Level 30, 360 Collins Street", "9888 Jasper Avenue NW, Suite 1100, Edmonton, Alberta", "Umhlanga Office", 
    "1775 Sherman Street Suite 1725, Denver Colorado", "Jamalco Main Office", "OnExpress WSP Hatch Office - 610 Chartwell Road", 
    "Shanghai Office", "Thompson Creek Mine", "USA Rare Earth Stillwater, OK", 
    "199 Bay Street, 26th Floor, Hatch-Metrolinx Joint Project Office", 
    "False Bay Building, Tygerberg Office Park, 163 Uys Krige Drive", "US Steel Gary", "Selous Metallurgical Complex, Selous, Zimbabwe", 
    "2-47 Darby Street", "Beijing Office", "Port of Saldanha Tippler 3 Project", "Mojave Micro Mill", 
    " Av. Santo Toribio 163, Edificio Real 8, San Isidro, Lima", "200 Churchill Drive, Suite 106", "Minera Escondida, Antofagasta, Chile", 
    "25 Atchison Street (NEO) Wollongong", "3 Berea Terrace, Rio Ridge Bldg. Berea East", "80 Hebron Way, Ste101, St. John's", 
    "1809 Barrington Street (HMM office)", "Avda. Chorillos #1631, Office 408", "600 Parker Square, Suite 225", "Botswana", 
    "Minneapolis Office", "1037 Raymond Boulevard, Newark, NJ 07102", "Jubail", "35 Railroad Row, Suite 201-203", "Mt Holly", 
    "Sydney, NS", "RTFT Plant Sorel-Tracy", "2860 rue Lawrie, Jonquiere, QC G7S 5P1", "Level 40, 360 Elizabeth Street, Melbourne", 
    "Nutrien White Springs Phosphate", "1100 H Street, NW, Suite 920", "HFJV Adelaide 100 Waymouth Street (Level 7) Adelaide SA 5000", 
    "3220 boul. St-Louis", "Atlanta Office", "Gautrain Management Agency - Midrand", "Atlantic Copper - Huelva", 
    "Confederation Line Extension, Ottawa", "Freeport Manju Refinery", "N7 Upgrading at Vissershok Project", "Onca Puma Project", 
    "1999 Harrison Street, Suite 620", "DART- 1401 Pacific Ave, Dallas", "Hatch Global Area", "Mossel Bay Office", "Rochester Office", 
    "Adelaide CBD", "KEP 197 St George Terrace, Perth", "RTA Deloitte Tower 21e", "Annacis Island Wastewater Treatment Plant New Outfall Project", 
    "Hamilton LRT, 100 King St W, 6th/7th floor", "Zimplats Expansion Project", "Lakeshore WPCP  Expansion", 
    "100 Sylvan Parkway, #200 Amherst, NY", "Australia-Asia (AUA) Area Parent", "400 - 1190, Av. des Canadiens-de-Montréal", 
    "London", "330 Industrial Ave., Kitimat B.C.", "EHTH Site - 375 Eastern Ave Toronto", "Rua Maria Luiza Santiago, 200 , 19th Floor", 
    "Olympic Dam SRE", "MBTA Riverside Car house", "Vedanta Gamsberg Zinc", " “Ingeniería de Detalles Proyecto Explotación Andesita”", 
    "Secunda Office", "Strathcona Preliminary Design", "Bureau Saguenay", "SkyTrain OMC 4", "U.S. Steel Gary Works, Finishing End", 
    "100 Sylvan Parkway, Amherst", "Winnipeg, Manitoba", "Charlotte Office", "Greenbelt, MD", "LHWP II - Polihali Transfer Tunnel", 
    "Mozambique LNG site", "Freeport-Mcmoran Miami Inc", "North End Pollution Control Center (NEWPCC)", "Olympic Dam SCM27", 
    "Portland Office", "Barry Camp", "East London", "MMR Detailed Engineering", "Qatalum Larger Anode Project", 
    "R22 Elimination of AT-grade crossings", "SEPTA 69th Street Shop", "Lakeshore WTP Expansion Site", "PBR Vancouver", 
    "Teck Metals Trail MSA Site Office", "Africa Europe Middle East (AEM) Area Parent", "Annacis Water Supply Tunnel", 
    "US Steel Edgar Thomson", "Upgrading Trunk Road 33/1", "BC Hydro Office", "Engineering Office", "Newark Office", 
    "REM - CIMA+/HATCH Coenterprise-Phase II", "Bridgestone Joliette", "NWMO Repository Design Development", 
    "PMCHS (Chuquicamata Underground) Project, Calama", " Reynolds Louisville Foil Plant", "Suite 1100, 9888 Jasper Avenue, Vancouver, AB", 
    "United States of America (USA) Area Parent", "BC Rail Site", "Mt Holly - PL2 East", "PT Smelting, Gresik Smelter, Indonesia", 
    "SCHM Baie-Comeau", "989 Changle Road, Level 20", "Andes Norte - Sistema Manejo Minerales -OP1 & OP2", "Hamilton, Ontario", 
    "Jwaneng Cut 9 Implementation Phase (FEL4)", "Northam Platinum Project Site", "Oakville NOC: Oakville", "Perth - 256 St Georges Tce", 
    "Richards Bay Minerals", "Snowy Hydro Relationship", "Sound Transit OMFC", "Alcoa Massena", "BHP Potash Office", "MLAP Project Site", 
    "South Quarter, Tower A, Level 9 Zone D", "South32- La Hermosa Mine", "Teck Trail Program", " Reconstruction des fours à cuisson 1&2", 
    "1, boul. Des Sources, Deschambault", "Laterriere Tailings Storage Facility (TSF)", "Simplot Project Site", 
    "Voisey’s Bay Mine Expansion Project", "Woodfibre LNG Site", "144 Stirling Street", "East Harbour Transit Hub - Detailed Design", 
    "Pattullo Bridge Replacement Project", "Pembina Prince Rupert Terminal", "South Fort Meade Eastern Expansion Project", "Jabiru", 
    "Sun Cable", "1050-1625 Broadway", "1600 West Carson Street, Pittsburgh, PA", "Arafura Project Office – 424 Murray St, Perth", 
    "IOC Sept-Iles", "Sudbury Integrated Nickel Operations (INO) Smelter", "Units 2601 & 2607, 26th Floor, CR Building Shenyang, 288 Qing Nian Da Jie", 
    "ABTPO Site", "Burloak Dr, Burlington", "Centro Comercial Primavera Urbana-Oficina 801 Villavicencio, Colombia", 
    "East New York Bus Depot", "Eastern Canada (ECA) Area Parent", "Kingston, Ontario", "Lone Tree Gold Mine", "Lumwana", 
    "Sao Luis Office", "Toronto Transit Commission, Vehicle Program Professional Services", "1066 West Hastings Street, Suite 400, Vancouver", 
    "1075 North Service Road West, Unit 21, Oakville", "110 Duncan Road, Prince Rupert, B.C., V8J 3P4 - Wainwright Marine facility", 
    "2240 Speakman Drive", "9980 Grace Rd, Surrey, BC V3V 3V7", "EGA Project Site", "Long branch Go Station", "Nyrstar Port Pirie", 
    "U.S. Steel Gary Works, Primary End", "109 St Georges Terrace", "3340 Peachtree Road NE suite 2675", "Penn Coach Yard", 
    "Contrato Marco Ing. Mayores DRT", "Mt Holly - Main Project Laydown Area", "Whabouchi Mine", "(RTA) #1 Smeltersite Road, Kitimat B.C.", 
    "Air Liquide - ASU", "Alstom - Hornell, NY", "BlueScope Steel Site", "Burloak Drive Grade Separation", "Sound Transit OMFE", 
    "2070 Speers Road", "Boston Metal - Coronel Xavier Chaves", "FMI Morenci", "Pomerleau-Bessac", "PWSA Sites", 
    "Réfection majeure tunnel L-H-La Fontaine", "US Steel McKeesport Site", "120 Wood Street, 2nd Floor", 
    "130 Adelaide St, Metrolinx OnCorr Project Site office", "313 Adelaide St", "Alcoa Baie-Comeau", "Alcoa Portland", 
    "Algoma Steel Inc - 105 West Street, Sault Ste Marie, Ontario, Canada P6A7B4", "Alouette", "BHP Coal Relationship", 
    "Cadia Expansion Project – Surface Engineering Services", "Eglinton LRT East Drive", "Esterhazy K3 Mine Site", "Europe (EUR) Area Parent", 
    "Expansion of Hwange Power Plant", "Hunter Valley Operations Coal Preparation Plant", "Mosaic K3 Esterhazy", "Nolan's Rare Earths Project", 
    "Rio Tinto Brisbane, 155 Charlotte Street", "Sibanye-Stillwater Marikana", "Sibanye-Stillwater Metallurgical Complex", 
    "1950 Rue Maurice Gauvin, Suite 300, Laval, QC H7S 1Z5 Mine Raglan Glencore", "25 Atchison Street (NEO)", "Alcoa Deschambault", 
    "Alstom - Plattsburgh", "Columbus Office", "Contrato de Prestación de Servicios", "Gary Works Tin Mill Engineering Building", 
    "Gautrain Capacity and Revenue Study", "Iron Bridge OPF, Marble Bar, WA", "Jwaneng Cut 9 Project Site", "KOCH Solutions, Wadgassen, Germany", 
    "No. 1 East Chang Ave. Beijing", "Tronox Fairbreeze", "Vales Point A Power Station", "300 Tingira Street, Pinkenba", 
    "425 South Financial Place, Ste 2909", "Arafura - Accommodation Village", "Arafura - Aileron Homestead", "Baie Comeau", 
    "Barrie Rail Corridor Expansion", "BMA Office", "Fraser Mine Site, Glencore Sudbury INO, Sudbury Ontario", "HPX3 EPCM Site Office", 
    "Melbourne Office", "Metra", "Mt Holly - External Walkway", "Mt Holly - PL1 East", "Perth - 10 Telethon Avenue", "PVDV site", 
    "RTA Vaudreuil, Jonquiere", "121 Wharf St (Whyatt Gallagher Building)", "231 Regent Street", "320 5th Avenue suite 402, New York, NY", 
    "ACP", "ACP Debottlenecking – Polokwane Early Capacity", "ATA Refinery", "Barrick Cowal Gold Mine Site", 
    "Belle Plaine Compaction Expansion, Saskatoon", "Big River Steel", "Brisbane Cross River Rail", "Engebo Rutile and Garnet Project – Execution", 
    "Ladore Preliminary Design", "Matias Romero 216 - Piso 4, Ciudad de Mexico", "Port Elizabeth", "Ranger Brine Concentrator Project", 
    "Sao Paulo Office", "Sishen South Project Site", "West Calgary Ring Road", "(blank)", "1202 Tech. Blvd. Suite 205", "1235 North Service Road", 
    "141 Adelaide Street, Suite 520", "2699 Speakman Drive, Mississauga", "310  Tehran-ro, #1010, Gangnam-gu", 
    "37 Carl Hall Rd, Downsview, North York", "5035 South Service Rd, Burlington", "Arafura - Explosive Storage Area", "Arafura - Process Plan Area", 
    "Arafura - Site Access Road", "Aurora Go Station", "Av. Bosque Norte 500 Piso 10", "BVFR Site", "Connell Hatch Brisbane", 
    "Copiapo Candelaria Site", "Coquitlam Main #4 Tunnel", "ECP Azufre II Revamp", "FMG Office 87 Adelaide Terrace, Perth, WA", "Geelong", 
    "Gerdau Selkirk: 27 Main St, Selkirk, MB", "Hell's Kitchen Geothermal Power Plant", "Hotel Delta Saguenay", "IEM Workshop - Vancouver", 
    "Kazakhstan", "Kenmar Mine", "Kenmare", "Lonmin Furnace 1 Rebuild Project Site", "Mosaic Program", "Mt Holly - PL2 West", 
    "Mt Holly - Project office", "My Holly - Security Gate – Main", "Newmont Ghana Ahafo Site", "Penn Ave Office", "Port Hope Project", 
    "Project LUCY – PRNC site office", "Raglan Phase II - MP14", "Regional Express Rail (RER) Package 1", "RTA ABF Alma", "Saldanha Site", 
    "USS Midwest Plant, Portage", "Vale LHPP Site", "Western Canada (WCA) Area Parent", 
    "Winnipeg North End Water Pollution Control Center Headworks Upgrade", "Yarwun Alumina Refinery Gladstone QLD", "Zhairem"
].sort();

const CATEGORIES_LIST = [
    "Access Breach", "Barricading", "Behaviour / General Conduct", "Caught Between", "Chemical", 
    "Collision", "Confined Space", "Contact With", "Cyber security", "Electrical", "Equipment Failure",
    "Ergonomics / Manual Handling", "Excavation", "Explosion", "Fall from Above", 
    "Fall from Above Objects", "Fall from Above Slips/Trips/Falls", "Fire", "Fire Prevention / Protection", 
    "Foreign Body", "Hazardous Substances", "Health/Medical/Disease", "Housekeeping", "Lifting and Rigging",
    "Lockout/Tagout, Danger Tag/Isolation", "Manual Handling", "Mobile Equipment", "Motor Vehicle", 
    "Noise", "Over/Near Water", "Permit to Work", "Personal Protective Equipment", "Procedure Breach", 
    "Quality Assurance/Quality Control", "Security", "Sharp Objects", "Signage", "Stacking Storage", 
    "Sustainability", "Thermal Stress (Hot / Cold)", "Travel", "Unguarded Equipment", "Weather Conditions",
    "Wildlife", "Work at Heights", "Workstation Ergonomics",
].sort();

export default function App() {
  const [status, setStatus] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [recognition, setRecognition] = useState<SpeechRecognition | null>(null);
  
  // Chat State
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isApiKeyValid, setIsApiKeyValid] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // API Key State
  const [apiKey, setApiKey] = useState("");

  // Form State
  const [project, setProject] = useState("Hatch Global (Project View)");
  const [office, setOffice] = useState("Johannesburg");
  const [address, setAddress] = useState("58 Emerald Parkway Road, Greenstone Hill");
  const [exactLoc, setExactLoc] = useState("office");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  
  const [isContractor, setIsContractor] = useState(false);
  const [isWorkHours, setIsWorkHours] = useState(false);
  const [obsType, setObsType] = useState("Behaviour");
  const [obsSafe, setObsSafe] = useState("Safe");
  const [officeLoc, setOfficeLoc] = useState("Hatch office");
  
  const [details, setDetails] = useState("");
  const [action, setAction] = useState("");
  const [category, setCategory] = useState(""); 
  const [cardType, setCardType] = useState("Field");

  const [isProjectLocked, setIsProjectLocked] = useState(false);
  const [isOfficeLocked, setIsOfficeLocked] = useState(false);
  const [isAddressLocked, setIsAddressLocked] = useState(false);

  // Dropdown state
  const [projectSearch, setProjectSearch] = useState("");
  const [officeSearch, setOfficeSearch] = useState("");
  const [addressSearch, setAddressSearch] = useState("");


  const colors = {
    bg: "#FAFAFA", surface: "#F0F0F0", border: "#BFBFBF", text: "#2E2E2E", 
    text_muted: "#595959", primary: "#425563", primary_hover: "#2F3C46", 
    input_bg: "#FFFFFF", input_text: "#2E2E2E", orange: "#E84A37"
  };

  // Initialize speech recognition
  useEffect(() => {
    const WindowSpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (WindowSpeechRecognition) {
      const recognitionInstance = new WindowSpeechRecognition() as SpeechRecognition;
      recognitionInstance.continuous = true;
      recognitionInstance.interimResults = false;
      recognitionInstance.lang = 'en-US';

      recognitionInstance.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((result: any) => result[0])
          .map((result: any) => result.transcript)
          .join('');
        setChatInput(prev => (prev.trim() + ' ' + transcript).trim());
      };

      recognitionInstance.onerror = (event: any) => {
        console.error("Speech recognition error", event.error);
        setIsRecording(false);
      };

      recognitionInstance.onend = () => {
        setIsRecording(false);
      };

      setRecognition(recognitionInstance);
    }
  }, []);

  const handleSaveApiKey = async () => {
    setStatus("Validating API key...");
    try {
      const result = await invoke<string>("store_api_key", { key: apiKey });
      setStatus(result);
      setIsApiKeyValid(true);
      setApiKey("");
    } catch (error) {
      setStatus(`${error}`);
      setIsApiKeyValid(false);
    }
  };

  const handleSendMessage = async () => {
    if (!chatInput.trim()) return;
    
    const userMsg = chatInput;
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setChatInput("");
    setIsAiLoading(true);

    try {
      const response = await invoke<string>("chat_with_ai", { prompt: userMsg });
      
      // Check if the response contains JSON to populate the form
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[0]);
          if (data.project !== undefined && data.project !== "") {
            setProject(data.project);
            setProjectSearch(data.project);
          }
          if (data.office !== undefined) {
            setOffice(data.office);
            setOfficeSearch(data.office);
          }
          if (data.address !== undefined) {
            setAddress(data.address);
            setAddressSearch(data.address);
          }
          if (data.exactLoc !== undefined) setExactLoc(data.exactLoc);
          
          // AI returns dd MMMM yyyy, need to convert back to YYYY-MM-DD for <input type="date">
          if (data.date !== undefined) {
            try {
              const d = new Date(data.date);
              if (!isNaN(d.getTime())) {
                setDate(d.toISOString().split('T')[0]);
              }
            } catch (e) {
              console.error("Failed to parse date from AI:", data.date);
            }
          }
          
          if (data.time !== undefined) setTime(data.time);
          if (data.isContractor !== undefined) setIsContractor(data.isContractor === "Yes");
          if (data.isWorkHours !== undefined) setIsWorkHours(data.isWorkHours === "Yes");
          if (data.obsType !== undefined) setObsType(data.obsType);
          if (data.obsSafe !== undefined) setObsSafe(data.obsSafe);
          if (data.officeLoc !== undefined) setOfficeLoc(data.officeLoc);
          if (data.details !== undefined) setDetails(data.details);
          if (data.action !== undefined) setAction(data.action);
          if (data.category !== undefined) setCategory(data.category); // Set category directly
          if (data.cardType !== undefined) setCardType(data.cardType);

          // Only show completion message if no error was reported by AI
          if (data.error) {
            setMessages(prev => [...prev, { role: 'ai', content: data.error }]);
            setIsAiLoading(false);
            return;
          }

          // Remove the JSON block and the specific intro text from the displayed message
          let cleanMessage = response.replace(jsonMatch[0], "").trim();
          cleanMessage = cleanMessage.replace("Based on your description, here's the extracted safety observation details:", "").trim();
          // Also check for the "Thank you..." phrase which is our completion signal
          setMessages(prev => [...prev, { role: 'ai', content: cleanMessage }]);
        } catch (e) {
          setMessages(prev => [...prev, { role: 'ai', content: response }]);
        }
      } else {
        setMessages(prev => [...prev, { role: 'ai', content: response }]);
      }
    } catch (error) {
      setMessages(prev => [...prev, { role: 'ai', content: `Error: ${error}` }]);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleStartRecording = () => {
    if (!recognition) {
      setStatus("Speech recognition not supported in this browser.");
      return;
    }
    if (isRecording) {
      recognition.stop();
    } else {
      try {
        recognition.start();
        setIsRecording(true);
      } catch (err) {
        console.error("Failed to start recognition:", err);
      }
    }
  };

  const formatDateStr = (dStr: string) => {
    if (!dStr) return "";
    const d = new Date(dStr);
    const day = String(d.getDate()).padStart(2, '0');
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${day}/${months[d.getMonth()]}/${d.getFullYear()}`;
  };

  const handleSetToday = () => setDate(new Date().toISOString().split("T")[0]);
  const handleSetNow = () => {
    const now = new Date();
    setTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = { project, office, address, exactLoc, date: formatDateStr(date), time, isContractor, isWorkHours, obsType, obsSafe, officeLoc, details, action, category, cardType };
      const result = await invoke<string>("submit_observation", { payload: JSON.stringify(payload) });
      setStatus(result);
    } catch (error) {
      setStatus(`Error: ${error}`);
    }
  };

  const inputStyle = { width: "100%", padding: "6px 8px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, color: colors.input_text, fontFamily: "inherit", boxSizing: "border-box" as const };
  const labelStyle = { fontSize: "11px", fontWeight: "bold", color: colors.text, marginBottom: "2px", display: "block" };
  const btnStyle = { padding: "6px 10px", border: `1px solid ${colors.border}`, borderRadius: "4px", backgroundColor: colors.input_bg, fontWeight: "bold", color: colors.text, fontSize: "11px", cursor: "pointer" };

  return (
    <div style={{ backgroundColor: colors.bg, color: colors.text, fontFamily: "'Source Sans Pro', Arial, sans-serif", padding: "16px", minHeight: "100vh" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <img src={hatchLogo} alt="HATCH" style={{ height: "28px" }} />
        <div style={{ fontSize: "15px", fontWeight: "bold" }}>Roam Observation Logger</div>
      </div>

      {/* Settings */}
      <div style={{ marginBottom: "16px", padding: "10px", backgroundColor: "white", border: `1px solid ${colors.border}`, borderRadius: "8px" }}>
        <label style={labelStyle}>GROQ API KEY</label>
        <div style={{ display: "flex", gap: "8px" }}>
          <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Enter API Key" style={inputStyle} />
          <button onClick={handleSaveApiKey} style={btnStyle}>Save Key</button>
        </div>
      </div>

      {/* Chat Interface */}
      <div style={{ marginBottom: "24px", border: `1px solid ${colors.border}`, borderRadius: "8px", overflow: "hidden", backgroundColor: "white", opacity: isApiKeyValid ? 1 : 0.6 }}>
        <div style={{ padding: "10px", backgroundColor: colors.surface, borderBottom: `1px solid ${colors.border}`, fontWeight: "bold", fontSize: "12px", display: "flex", justifyContent: "space-between" }}>
          <span>AI Copilot</span>
          {!isApiKeyValid && <span style={{ color: colors.orange, fontSize: "10px" }}>Connect API Key to enable chat</span>}
        </div>
        <div style={{ height: "200px", overflowY: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', backgroundColor: msg.role === 'user' ? colors.primary : colors.surface, color: msg.role === 'user' ? 'white' : colors.text, padding: "6px 10px", borderRadius: "8px", fontSize: "13px", maxWidth: "80%" }}>
              {msg.content}
            </div>
          ))}
          {isAiLoading && <div style={{ fontSize: "12px", color: colors.text_muted }}>AI is thinking...</div>}
          <div ref={chatEndRef} />
        </div>
        <div style={{ padding: "10px", borderTop: `1px solid ${colors.border}`, display: "flex", gap: "8px" }}>
          <input 
            value={chatInput} 
            onChange={e => setChatInput(e.target.value)} 
            placeholder={isApiKeyValid ? "Provide details about your observation..." : "API Key required"} 
            style={{ ...inputStyle, backgroundColor: isApiKeyValid ? colors.input_bg : "#F5F5F5" }}
            onKeyDown={e => e.key === 'Enter' && isApiKeyValid && handleSendMessage()}
            disabled={!isApiKeyValid}
          />
          <button onClick={handleStartRecording} disabled={!isApiKeyValid} style={{ ...btnStyle, backgroundColor: isRecording ? colors.orange : colors.surface, cursor: isApiKeyValid ? "pointer" : "not-allowed" }}>🎤</button>
          <button onClick={handleSendMessage} disabled={!isApiKeyValid} style={{ ...btnStyle, backgroundColor: colors.primary, color: "white", cursor: isApiKeyValid ? "pointer" : "not-allowed", opacity: isApiKeyValid ? 1 : 0.5 }}>Send</button>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "8px", alignItems: "center" }}>
          <label style={labelStyle}>PROJECT</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <select 
              value={isProjectLocked ? project : projectSearch || project} 
              onChange={e => {setProject(e.target.value); setProjectSearch(e.target.value);}} 
              disabled={isProjectLocked} 
              style={{ ...inputStyle, backgroundColor: isProjectLocked ? "#E0E0E0" : colors.input_bg }}
            >
              {PROJECTS_LIST.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <button type="button" onClick={() => setIsProjectLocked(!isProjectLocked)} style={btnStyle}>{isProjectLocked ? "Unlock" : "Lock"}</button>
          </div>
          
          <label style={labelStyle}>OFFICE</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <select 
              value={isOfficeLocked ? office : officeSearch || office} 
              onChange={e => {setOffice(e.target.value); setOfficeSearch(e.target.value);}} 
              disabled={isOfficeLocked} 
              style={{ ...inputStyle, backgroundColor: isOfficeLocked ? "#E0E0E0" : colors.input_bg }}
            >
              {CITIES_LIST.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button type="button" onClick={() => setIsOfficeLocked(!isOfficeLocked)} style={btnStyle}>{isOfficeLocked ? "Unlock" : "Lock"}</button>
          </div>
          
          <label style={labelStyle}>ADDRESS</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <select 
              value={isAddressLocked ? address : addressSearch || address} 
              onChange={e => {setAddress(e.target.value); setAddressSearch(e.target.value);}} 
              disabled={isAddressLocked} 
              style={{ ...inputStyle, backgroundColor: isAddressLocked ? "#E0E0E0" : colors.input_bg }}
            >
              {STREETS_LIST.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button type="button" onClick={() => setIsAddressLocked(!isAddressLocked)} style={btnStyle}>{isAddressLocked ? "Unlock" : "Lock"}</button>
          </div>
          
          <label style={labelStyle}>LOCATION</label>
          <input value={exactLoc} onChange={e => setExactLoc(e.target.value)} placeholder="Exact location" style={inputStyle} />
          
          <label style={labelStyle}>DATE</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
            <button type="button" onClick={handleSetToday} style={btnStyle}>Today</button>
          </div>
          
          <label style={labelStyle}>TIME</label>
          <div style={{ display: "flex", gap: "6px" }}>
            <input type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
            <button type="button" onClick={handleSetNow} style={btnStyle} tabIndex={1}>Now</button>
          </div>
        </div>

        <div style={{ backgroundColor: colors.surface, borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Was the work performed by a Contractor?</span>
            <div 
              onClick={() => setIsContractor(!isContractor)} 
              tabIndex={2}
              onKeyDown={(e) => e.key === 'Enter' && setIsContractor(!isContractor)}
              style={{ width: "50px", height: "28px", backgroundColor: isContractor ? colors.orange : "#8C8C8C", borderRadius: "14px", position: "relative", cursor: "pointer", display: "flex", alignItems: "center", padding: "0 6px", boxSizing: "border-box", justifyContent: isContractor ? "flex-start" : "flex-end", transition: "background-color 0.2s" }}
            >
              <span style={{ color: "white", fontSize: "10px", fontWeight: "bold" }}>{isContractor ? "Yes" : "No"}</span>
              <div style={{ width: "24px", height: "24px", backgroundColor: "white", borderRadius: "50%", position: "absolute", top: "2px", left: isContractor ? "24px" : "2px", transition: "left 0.2s" }} />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Was this observed during working hours?</span>
            <div 
              onClick={() => setIsWorkHours(!isWorkHours)} 
              tabIndex={3}
              onKeyDown={(e) => e.key === 'Enter' && setIsWorkHours(!isWorkHours)}
              style={{ width: "50px", height: "28px", backgroundColor: isWorkHours ? colors.orange : "#8C8C8C", borderRadius: "14px", position: "relative", cursor: "pointer", display: "flex", alignItems: "center", padding: "0 6px", boxSizing: "border-box", justifyContent: isWorkHours ? "flex-start" : "flex-end", transition: "background-color 0.2s" }}
            >
              <span style={{ color: "white", fontSize: "10px", fontWeight: "bold" }}>{isWorkHours ? "Yes" : "No"}</span>
              <div style={{ width: "24px", height: "24px", backgroundColor: "white", borderRadius: "50%", position: "absolute", top: "2px", left: isWorkHours ? "24px" : "2px", transition: "left 0.2s" }} />
            </div>
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Behaviour", "Condition"].map((t, idx) => <button key={t} type="button" tabIndex={idx === 0 ? 4 : undefined} onClick={() => setObsType(t)} style={{ flex: 1, padding: "4px", backgroundColor: obsType === t ? colors.input_bg : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer" }}>{t}</button>)}
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Safe", "At Risk"].map(t => <button key={t} type="button" onClick={() => setObsSafe(t)} style={{ flex: 1, padding: "4px", backgroundColor: obsSafe === t ? colors.input_bg : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer" }}>{t}</button>)}
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {["Hatch office", "Home office", "Site/Client"].map(t => <button key={t} type="button" onClick={() => setOfficeLoc(t)} style={{ flex: 1, padding: "4px", backgroundColor: officeLoc === t ? colors.input_bg : "transparent", border: `1px solid ${colors.border}`, borderRadius: "4px", fontWeight: "bold", fontSize: "11px", cursor: "pointer" }}>{t}</button>)}
          </div>
        </div>

        <div>
          <label style={labelStyle}>OBSERVATION DETAILS</label>
          <textarea value={details} onChange={e => setDetails(e.target.value)} placeholder="Enter observation details..." style={{ ...inputStyle, height: "60px", resize: "none" }} />
        </div>

        <div>
          <label style={labelStyle}>IMMEDIATE ACTION</label>
          <textarea value={action} onChange={e => setAction(e.target.value)} placeholder="Enter immediate action taken..." style={{ ...inputStyle, height: "60px", resize: "none" }} />
        </div>

        <div>
          <label style={labelStyle}>CATEGORY</label>
          <select 
            value={category} 
            onChange={e => setCategory(e.target.value)} 
            style={inputStyle}
          >
            <option value="">Select Category</option>
            {CATEGORIES_LIST.map(cat => <option key={cat} value={cat}>{cat}</option>)}
          </select>
        </div>

        <div>
          <label style={labelStyle}>SAFETY CARD TYPE</label>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" onClick={() => setCardType("Design")} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Design" ? "#F3C200" : colors.surface }}>Design</button>
            <button type="button" onClick={() => setCardType("Field")} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Field" ? "#1A7F37" : colors.surface, color: cardType === "Field" ? "white" : colors.text }}>Field</button>
            <button type="button" onClick={() => setCardType("Office")} style={{ ...btnStyle, flex: 1, backgroundColor: cardType === "Office" ? "#0D8BFF" : colors.surface, color: cardType === "Office" ? "white" : colors.text }}>Office</button>
          </div>
        </div>

        <button type="submit" style={{ padding: "12px 20px", backgroundColor: colors.primary, color: "#FFFFFF", border: "none", borderRadius: "8px", fontWeight: "bold", fontSize: "14px", cursor: "pointer", marginTop: "10px" }}>
          Submit Observation
        </button>
        {status && <div style={{ color: colors.primary, fontWeight: "bold", textAlign: "center" }}>{status}</div>}
      </form>
    </div>
  );
}
