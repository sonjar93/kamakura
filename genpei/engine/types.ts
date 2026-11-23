/**
 * 平安・鎌倉動乱記 ― データ型定義（Web版 React+TypeScript 移行用）
 * engine.js の状態オブジェクトと scenario_*.json はこの型に従う。
 */
export type Confidence = '史実' | '有力説' | '推定' | '伝承' | 'ゲーム設定' | '要確認';
export type ID = string;

export interface GameDate { y: number; m: number; leap: boolean; d: number } // 西暦年＋和暦の月日（閏月フラグ）

export interface Province {
  id: ID; name: string; circuit: string; x: number; y: number;
  terrain: string; snowyWinter: boolean; paddyCho: number; output: number; // 田積(町)・生産(石/年)
  kokuga: { holder: ID | null; confidence: Confidence; note: string };      // 国衙（知行国主）
  unrest: number; devastation: number;
}
export interface Road { id: ID; a: ID; b: ID; name: string; kind: 'land' | 'mountain' | 'sea'; km: number; note: string; confidence: Confidence }

export type BaseType = '都' | '御所' | '館' | '城' | '寺社' | '港' | '国府';
export interface Base {
  id: ID; name: string; province: ID; type: BaseType; owner: ID | null;
  defense: number; maxDefense: number; garrison: number; x: number; y: number;
  confidence: Confidence; note: string; burned?: boolean;
}
export interface Band { id: ID; faction: ID | null; province: ID; name: string; strength: number; base: number; mobilized: number; confidence: Confidence }
export interface Holding {
  id: ID; name: string; province: ID; type: '荘園' | '荘園群' | '国衙領' | '御厨' | '寺社領' | '私領' | '郷' | '郡';
  proprietor: string;      // 本所・領家（名目）
  controller: ID | null;   // 実効支配する勢力
  output: number; confidence: Confidence; note: string;
  rights: {                // v0.9：権利の分離
    honjo: ID | null;      // 本所（名目上の権利者。朝廷＝'court'・寺社の勢力ID。私領は null）
    taxHolder: ID | null;  // 徴税権（国衙領＝知行国主、荘園＝預所・下司）
    jito: ID | null;       // 地頭（幕府が文治元年11月以降に設置）
  };
  oryo: boolean;           // 押領されている（実効支配する家が、戦う相手の取り分を押さえている）
}

export interface BaseSupply { food?: number; hunger?: number } // 拠点の籠城用の兵糧と、兵糧切れの日数（v0.9）
export interface Regime {   // v1.0：政権の体制（0〜100）。政治的正統性は Faction.legitimacy を使う
  leaderDep: number; maturity: number; heirStab: number; cohesion: number; central: number; local: number; diplomacy?: number;
  goal: string; note: string; confidence: Confidence; heirBase?: number; commandBonus?: number; cooldown?: Record<string, number>;
  lastSuccession?: { day: number; date: string; from: ID; to: ID; kind: 'stable' | 'strife' | 'revolt' | 'split'; score: number; rival: ID | null };
}
export interface House {    // 勢力の内側にある家（北条氏・比企氏・土肥氏など）。勢力と家系を分けて扱う
  id: ID; name: string; faction: ID; head: ID | null; members: ID[]; influence: number; ambition: number; favor?: number; note: string;
  lord: ID; heir: ID | null; money: number; food: number; loyalty: number; seat: ID | null;  // v1.1：主君・後継・蔵・忠誠・本拠
  lastGrant?: number; asFaction?: ID;   // 新恩の日・勢力に切り出した後の勢力ID
}
// v1.1：Band.house（家の郎党。主君の直轄兵と分ける）、Holding.house（家の本領）、Holding.seat（拠点とともに動く所領）、
//       Holding.facilities（{kind,progress,days,done,builder,payer}）、Base.house、Army.joinCorps/contingentOf/house（参陣中の軍）、
//       Corps.contingents（{name,decision:'join'|'late'|'refuse'|'joined'|'late-joined'|'left',troops,rendezvous,eta,why}）、Corps.recorded（軍記の騎数と実数）、Corps.route/parent/vice
export interface Faction {
  id: ID; name: string; type: string; color: string; leader: ID; heir?: ID; capital: ID | null;
  money: number; food: number; policy: string; ambition: number; courtRelation: number; legitimacy: number;
  playable: boolean; status: '政権' | '雌伏' | '密謀' | '挙兵' | '在地' | '安定' | '流浪' | string;
  overlord: ID | null; navy: boolean; alive: boolean; description: string;
  flags: Record<string, boolean | number>;   // ryoji（令旨受領）, choteki（朝敵）, warned, uprising_<id> ...
  ai: { posture: string; lastInvite?: number; lastFlight?: number; memo: string };
  lastIncome?: { money: number; food: number; upkeep: number };
  regime: Regime;           // flags.strifeUntil：家中の内紛が続く日
}

export interface Abilities { command: number; valor: number; politics: number; intellect: number; diplomacy: number }
export interface Person {
  id: ID; name: string; kana: string; born: number | null; died: number | null; birthConfidence: Confidence;
  faction: ID | null; status: string;
  rank: string;              // 位階（官位）
  courtOffices: string[];    // 朝廷の官職
  warriorOffices: string[];  // 武家役職（侍所別当・守護など）
  abilities: Abilities; abilitiesConfidence: Confidence; personality: string; ambition: number; loyalty: number;
  relations: { person: ID; type: string }[];
  location: ID | `army:${string}` | `envoy:${string}` | null;
  alive: boolean; health: number; captiveOf: ID | null;
  naturalDeath: (GameDate & { confidence: Confidence }) | null;  // 史実の病没日（史実寄せモード用）
  deathDate?: string; deathCause?: 'battle' | 'illness'; note: string;
}
export interface Relation { a: ID; b: ID; value: number; status: '主従' | '同盟' | '友好' | '中立' | '緊張' | '対立' | '敵対' | '監視' | '和睦' | string; war: boolean }

export interface Office { id: ID; name: string; category: '官職' | '地位' | '武家役職'; established: number; abolished: number | null; note: string }
export interface CourtClique {             // 朝廷内の派閥（v0.8）
  id: 'in' | 'sekkan' | 'tenno' | 'shinhei' | 'jisha' | string; name: string;
  leader: ID | null; members: ID[]; influence: number;          // 影響力（2〜60）
  attitude: Record<ID, number>;   // 各武家への態度（-100〜100）。毎月、目標値へ1割ずつ近づく
  bias: Record<ID, number>;       // 史実上の傾き（初期値）
  favor: Record<ID, number>;      // 献金・儀式の支援の恩（毎月5%ずつ薄れる）
  grudge?: Record<ID, number>;    // 恨み（南都焼討など）
  interest: string; confidence: Confidence; note: string;
}
export interface Court {
  location: ID; emperor: ID; cloisteredEmperor: ID; dharmaEmperor: ID; dharmaEmperorConfined: boolean;
  regent: ID; regentTitle: '摂政' | '関白';
  ministers: { daijodaijin: ID | null; sadaijin: ID | null; udaijin: ID | null; naidaijin: ID | null };
  dominance: Record<string, number>;   // 朝廷内の主導権
  controller: ID; edicts: { type: string; target: ID; requester?: ID; date: string; day: number }[];
  pendingPetitions: { id: ID; from: ID; kind: 'tsuito' | 'appointment' | 'insen'; target?: ID | null; person?: ID; office?: ID; decideDay: number; chance: number }[];
  cliques: Record<string, CourtClique>;
  gaiseki: ID | null;                        // 天皇の外戚の家（安徳天皇なら平家）
  rivalEmperor?: { person: ID; with: ID | null; since: number }; // 都を離れた帝（二帝並立）
  emperorAwaySince: number | null; lastInsen: Record<ID, number>; lastInsenAny?: number; lastGift?: Record<string, number>;
}
export type ObjectiveCond =
  | { t: 'courtControl' | 'bakufu' | 'notVassal' | 'alive'; label?: string }
  | { t: 'notController'; f: ID; label?: string }
  | { t: 'provinces'; list: ID[]; n: number; camp?: boolean; label?: string }
  | { t: 'institutions'; list: string[]; label?: string }
  | { t: 'office'; list: string[]; label?: string }
  | { t: 'support'; min: number; label?: string }
  | { t: 'anyOf'; list: ObjectiveCond[]; label?: string }
  | { t: 'holdBase'; base: ID; label?: string }
  | { t: 'minBases'; n: number; label?: string }
  | { t: 'money'; min: number; label?: string }
  | { t: 'date'; y: number; m: number; label?: string };
export interface Objective { title: string; text: string; conds: ObjectiveCond[] }

export interface Army {
  id: ID; faction: ID; name: string | null; commander: ID | null; officers: ID[];
  troops: number; initialTroops: number; morale: number; fatigue: number; food: number;
  province: ID; base: ID | null; edge: { road: ID; from: ID; to: ID; km: number; done: number } | null;
  path: ID[]; target: { type: 'province' | 'base'; id: ID } | null;
  mission: 'idle' | 'move' | 'attack' | 'defend' | 'hold' | 'retreat' | 'flight';
  status: 'idle' | 'gathering' | 'marching' | 'retreating' | 'battle' | 'siege' | 'arrived';
  gatherUntil: number | null; bands: { band: ID; n: number }[]; battleId: ID | null; idleDays: number;
  supply?: number | null;  // 補給線の距離（km）。null は補給線の外（v0.9）
  starve?: number;         // 兵糧切れの日数（6日で退却）
}
export interface Envoy { id: ID; faction: ID; person: ID | null; province: ID; path: ID[]; edge: Army['edge']; speed: number; dest: ID; payload: any }
export interface Battle { id: ID; name: string; province: ID; base: ID | null; sides: { att: ID[]; def: ID[] }; days: number; start: { att: number; def: number }; losses: { att: number; def: number }; attFaction: ID; defFaction: ID | null; surprise: 'att' | null }

export interface StopEvent { id: ID; key: string; title: string; date: string; day: number; place?: string; persons?: ID[]; text: string; choices: { id: string; label: string }[]; resolved: boolean }
export interface LogEntry { day: number; date: string; text: string; type: string; factions: ID[]; important: boolean; province: ID | null }

export type Command =
  | { type: 'mobilize'; faction?: ID; province: ID; troops?: number | null; commander?: ID | null; target?: Army['target']; mission?: Army['mission'] }
  | { type: 'march'; faction?: ID; army: ID; target: NonNullable<Army['target']>; declare?: boolean }
  | { type: 'disband'; faction?: ID; army: ID }
  | { type: 'envoy'; faction?: ID; person: ID; to: ID; proposal: 'alliance' | 'vassal_request' | 'submit' | 'peace' | 'break' }
  | { type: 'declare_war'; faction?: ID; to: ID }
  | { type: 'uprising'; faction?: ID }
  | { type: 'petition'; faction?: ID; kind: 'tsuito'; target: ID }
  | { type: 'petition'; faction?: ID; kind: 'appointment'; person: ID; office: ID; gift?: number }
  | { type: 'petition'; faction?: ID; kind: 'insen'; target?: ID | null }      // 院宣を求める（法皇が自由の身のとき）
  | { type: 'court_gift'; faction?: ID; clique: string; amount: number }      // 派閥への献金・儀式の支援
  | { type: 'petition'; faction?: ID; kind: 'kokushi'; province: ID }       // 知行国（国司の任命）の申請
  | { type: 'jito'; faction?: ID; holding: ID }                             // 地頭の設置
  | { type: 'regime'; faction?: ID; action: 'heir_base' | 'appoint' | 'mediate' | 'admin' | 'local' | 'reward' | 'command' | 'decentralize'; person?: ID }
  | { type: 'set_heir'; faction?: ID; person: ID }
  | { type: 'spoil'; faction?: ID; holding: ID; to: ID | 'direct' }           // 没官領の処分
  | { type: 'ando'; faction?: ID; target: ID }                                // 本領安堵（家または御家人の勢力）
  | { type: 'grant'; faction?: ID; holding: ID; target: ID }                  // 新恩給与
  | { type: 'confiscate'; faction?: ID; holding: ID }                         // 没収
  | { type: 'build_facility'; faction?: ID; holding: ID; kind: string; payer?: 'lord' | 'self' }
  | { type: 'bakufu'; faction?: ID; act: 'ally' | 'marriage' | 'seek' | 'isolate' | 'exploit' | 'impeach' | 'attack' | 'shikken'; target?: ID; office?: string }
  | { type: 'reform'; faction?: ID; kind: 'shikken_power' | 'rensho' | 'hyojoshu' | 'litigation' | 'land_admin' | 'local_gov' | 'gokenin_ctl'; person?: ID }
  | { type: 'appoint_office'; faction?: ID; office: string; person: ID }
  | { type: 'split_corps'; faction?: ID; corps: ID; groups: { armies: ID[]; route?: 'tokaido' | 'tosando' | 'hokurikudo' | 'sanyodo' | 'auto'; commander?: ID; vice?: ID; target?: Army['target'] }[] }
  | { type: 'donate'; faction?: ID; base: ID; amount: number }
  | { type: 'buy_food'; faction?: ID; amount: number }
  | { type: 'set_capital'; faction?: ID; base: ID };

export interface PlayerControl { faction: ID; house: ID | null; history: { day: number; date: string; from: ID; to: ID; reason: string }[] } // v1.2：操作対象（勢力・家と別に管理）
export interface Shogunate {   // v1.2：幕府の御家人政治
  inf: Record<ID, number>; ties: Record<string, number>; wary: Record<ID, number>; impeached?: Record<ID, number>;
  shikken: { holder: ID; person: ID; since: number; date: string } | null; rensho: { holder: ID; person: ID } | null;
  reforms: Record<string, { start: number; days: number; done: boolean }>; hyojo: ID[]; log: { day: number; date: string; text: string }[];
}
export interface GameState {
  engineVersion: string; scenarioId: string; date: GameDate; day: number; rng: number; seq: number;
  playerFaction: ID | null; options: { mode: 'historical' | 'free'; mortality: 'historical' | 'random'; aiInterval: number; difficulty: 'easy' | 'normal' | 'hard'; goal: 'objective' | 'survive' | 'unify' | 'none' };
  objectives: Record<ID, Objective>;
  houses: Record<ID, House>;
  player: PlayerControl;      // playerFaction は player.faction の写し（既存コードとの互換）
  shogunate?: Shogunate;
  spoils?: { holding: ID; lord: ID; from: ID; day: number }[];   // v1.3：処分待ちの没官領
  service?: Record<ID, Record<ID, number>>;                       // v1.3：主君ごとの、家・御家人の報いられていない奉公
  provinces: Record<ID, Province>; roads: Record<ID, Road>; adj: Record<ID, ID[]>;
  factions: Record<ID, Faction>; persons: Record<ID, Person>; bases: Record<ID, Base>; bands: Record<ID, Band>;
  holdings: Record<ID, Holding>; relations: Record<string, Relation>; court: Court; offices: Office[];
  armies: Record<ID, Army>; envoys: Record<ID, Envoy>; battles: Record<ID, Battle>;
  orders: { executeDay: number; cmd: Command; label: string }[];
  intel: { faction: ID; key: string; day: number; text?: string }[];
  flags: Record<string, any>; firedEvents: Record<string, number>;
  pendingStops: StopEvent[]; eventHistory: any[]; commandHistory: any[]; battleHistory: any[];
  log: LogEntry[]; aiLog: { day: number; date: string; faction: ID | 'court'; action: string; reason: string; speech: string | null }[]; // speech：評定の言葉（テンプレ）
}
