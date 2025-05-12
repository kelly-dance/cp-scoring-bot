import { ChatInputCommandInteraction, Client, Events, GatewayIntentBits, Interaction, InteractionContextType, MessageFlags, REST, Routes, SharedSlashCommand, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder } from "discord.js";
import fetch from "node-fetch";
import fs from "node:fs";
import { exit } from "node:process";
const config: {
  token: string,
  clientId: string,
  development: boolean,
  admins: string[],
  guild: string,
  aliases: Record<string, string>,
  leaderboards: Record<string, {
    start: number,
    end: number,
    membership: 'open' | 'closed',
    bounties: string[],
  }>,
} = require('../config.json');

enum Platform {
  codeforces = 'codeforces',
  kattis = 'kattis',
}

type Submission = {
  problem_id: string,
  time: number,
};

type CodeforcesSubmission = Submission & {
  type: 'virtual' | 'contestant' | 'practice',
};

type CodeforcesContest = {
  contest_id: string,
  time: number,
};

type UserData = {
  display_name: string,
  kattis_username?: string,
  codeforces_username?: string,
  affiliation: string,
  last_checked: number,
  id: string,
  codeforces_submissions:  CodeforcesSubmission[],
  kattis_submissions:  Submission[],
  contests: CodeforcesContest[]
};

const userData = new Map<string, UserData>;

const BACKEND_URL = "https://byu-cpc-backend-433866642768.us-west1.run.app";
const updateUserData = async () => {
  const res = await fetch(`${BACKEND_URL}/get_users`);
  const raw = await res.json() as any[];
  for(const item of raw){
    const user: UserData = {
      display_name: item.display_name,
      kattis_username: item.kattis_username,
      codeforces_username: item.codeforces_username,
      affiliation: item.affiliation,
      id: item.id,
      last_checked: item.last_checked,
      kattis_submissions: [],
      codeforces_submissions: [],
      contests: [],
    };
    if(item.codeforces_submissions != null) {
      user.codeforces_submissions = Object.entries(item.codeforces_submissions)
        .filter(([key, _]) => key != 'contests')
        .map(([key, value]) => ({
        problem_id: key,
        time: (value as any).time,
        type: (value as any).type,
      })).sort((a,b) => a.time - b.time);
    }
    if(item.kattis_submissions != null) {
      user.kattis_submissions = Object.entries(item.kattis_submissions).map(([key, value]) => ({
        problem_id: key,
        time: value as number,
      })).sort((a,b) => a.time - b.time);
    }
    userData.set(user.id, user);
  }
};
setInterval(updateUserData, 600e3);

type Problem = {
  name: string,
  rating: number,
  id: string,
  platform: Platform,
}

const problemData = new Map<string, Problem>();
const updateProblemData = async () => {
  const res = await fetch(`${BACKEND_URL}/get_all_problems`);
  const raw = await res.json() as any;
  for(const [id, data] of Object.entries<any>(raw.codeforces)){
    problemData.set(id, {
      id,
      name: data.name,
      rating: data.rating,
      platform: Platform.codeforces,
    });
  }
  for(const [id, data] of Object.entries<any>(raw.kattis)){
    problemData.set(id, {
      id,
      name: data.name,
      rating: data.rating,
      platform: Platform.kattis,
    });
  }
}
setInterval(updateProblemData, 600e3);

type DbEntry = {
  id?: string,
  leaderboards: string[],
};

export const db = new Proxy(
  JSON.parse(fs.readFileSync('./db.json', 'utf8')),
  {
    get(target, id){
      if(typeof id !== 'string') return undefined;
      if(!target[id]) target[id] = { leaderboards: [] };
      return new Proxy(target[id], {
        set(userdata, key, value){
          userdata[key] = value;
          fs.writeFileSync('./db.json', JSON.stringify(target))
          return true;
        },
      })
    }
  }
) as Record<string, DbEntry>;

const exponent = 5/4;
const calcUserScore = (userid: string, start: number, end: number, bounties: Set<string>) => {
  if(!userData.has(userid)) return 0;
  const user = userData.get(userid)!;
  let score = 0;
  for(const problem of user.kattis_submissions){
    if(problem.time < start || problem.time > end) continue;
    const probleminfo = problemData.get(problem.problem_id);
    let value = (probleminfo?.rating || 1) ** exponent;
    if(bounties.has(problem.problem_id)) value *= 2;
    score += value;
  }
  for(const problem of user.codeforces_submissions){
    if(problem.time < start || problem.time > end) continue;
    const probleminfo = problemData.get(problem.problem_id);
    let value = (((probleminfo?.rating || 800)/25-17)/10) ** exponent;
    if(problem.type == 'contestant') value *= 2;
    if(bounties.has(problem.problem_id)) value *= 2;
    score += value;
  }
  for(const contest of user.contests){
    if(contest.time < start || contest.time > end) continue;
    score += 100;
  }
  return score;
};

const closedLeaderboardOptions: {name: string, value: string}[] = [];
for(const alias in config.aliases){
  if(config.leaderboards[config.aliases[alias]].membership == 'closed'){
    closedLeaderboardOptions.push({ name: alias, value: alias });
  } 
}
for(const literal in config.leaderboards){
  if(config.leaderboards[literal].membership == 'closed'){
    closedLeaderboardOptions.push({ name: literal, value: literal });
  }
}
const allLeaderboardOptions: {name: string, value: string}[] = 
  [...Object.keys(config.aliases), ...Object.keys(config.leaderboards)]
    .map(lb => ({ name: lb, value: lb }));

const resolveLeaderboard = (lb: string | undefined | null) => {
  if(typeof(lb) == 'string') lb = lb.toLowerCase();
  if(lb in config.aliases) lb = config.aliases[lb];
  if(!(lb in config.leaderboards)) throw new Error("Unknown leaderboard");
  return lb;
}

type Command = {
  data: SharedSlashCommand,
  execute: (interaction: ChatInputCommandInteraction) => Promise<any>,
}

const commands: Command[] = [
  {
    data: new SlashCommandBuilder()
      .setName('register')
      .setDescription('Update the registration info for a user')
      .addUserOption(option => option.setName('target').setDescription('Who to set').setRequired(true))
      .addStringOption(option => option.setName('id').setDescription('byu cpc id thingy').setRequired(true)),
    async execute(interaction) {
      if(!config.admins.some(admin => admin == interaction.member.user.id)) {
        await interaction.reply({ content: 'You do not have permission to use this command!', flags: MessageFlags.Ephemeral });
        return;
      }

      const user = interaction.options.getUser('target', true);
      const id = interaction.options.getString('id', true);

      db[user.id].id = id;

      await interaction.reply({ content: 'Done.', flags: MessageFlags.Ephemeral })
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('add')
      .setDescription('Add a user to a leaderboard')
      .addUserOption(option =>
          option.setName('target')
          .setDescription('Who to add')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('leaderboard')
        .setDescription('Leaderboard id or alias to add to')
        .setChoices(closedLeaderboardOptions)
        .setRequired(true)
      ),
    async execute(interaction) {
      if(!config.admins.some(admin => admin == interaction.member.user.id)) {
        await interaction.reply({ content: 'You do not have permission to use this command!', flags: MessageFlags.Ephemeral });
        return;
      }

      const user = interaction.options.getUser('target', true);
      const leaderboard = resolveLeaderboard(interaction.options.getString('leaderboard', true));

      db[user.id].leaderboards = [...new Set([leaderboard, ...db[user.id].leaderboards])]

      await interaction.reply({ content: 'Done.', flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('remove')
      .setDescription('Remove a user from a leaderboard')
      .addUserOption(option =>
          option.setName('target')
          .setDescription('Who to remove')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('leaderboard')
        .setDescription('Leaderboard id or alias to remove from')
        .setChoices(closedLeaderboardOptions)
        .setRequired(true)
      ),
    async execute(interaction) {
      if(!config.admins.some(admin => admin == interaction.member.user.id)) {
        await interaction.reply({ content: 'You do not have permission to use this command!', flags: MessageFlags.Ephemeral });
        return;
      }

      const user = interaction.options.getUser('target', true);
      const leaderboard = resolveLeaderboard(interaction.options.getString('leaderboard', true))

      db[user.id].leaderboards = db[user.id].leaderboards.filter(x => x != leaderboard);

      await interaction.reply({ content: 'Done.', flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('find')
      .setDescription('Search for someone\'s id')
      .addStringOption(option =>
        option.setName('query')
        .setDescription('string to search with')
        .setRequired(true)
      ),
    async execute(interaction) {
      if(!config.admins.some(admin => admin == interaction.member.user.id)) {
        await interaction.reply({ content: 'You do not have permission to use this command!', flags: MessageFlags.Ephemeral });
        return;
      }

      const query = interaction.options.getString('query', true).toLowerCase();

      const candidates: UserData[] = [];
      for(const user of userData.values()){
        if([user.display_name, user.kattis_username ?? '', user.codeforces_username ?? ''].some(s => s.toLowerCase().includes(query))){
          candidates.push(user);
        }
      }

      const lines = [];

      if(candidates.length === 0){
        lines.push("No results found");
      }else{
        for(const cand of candidates){
          let line = `display: '${cand.display_name}' `;
          if(cand.kattis_username) line += `kattis: '${cand.kattis_username}' `;
          if(cand.codeforces_username) line += `cf: '${cand.codeforces_username}' `;
          line += `id: '${cand.id}'`
          lines.push(line);
        }
      }

      await interaction.reply({ content: '```\n'+lines.join('\n')+'```', flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('view')
      .setDescription('View a leaderboard')
      .addStringOption(option =>
        option.setName('leaderboard')
        .setDescription('Leaderboard id or alias to view')
        .setChoices(allLeaderboardOptions)
        .setRequired(true)
      )
      .addNumberOption(option => 
        option.setName('page')
        .setDescription('Leave this parameter empty to see around yourself')
        .setMinValue(1)
      ),
    async execute(interaction) {
      // hopefully this never becomes needed
      // await interaction.deferReply();

      const leaderboard = resolveLeaderboard(interaction.options.getString('leaderboard', true));
      const page = interaction.options.getNumber('page', false) ?? 0;

      const lbinfo = config.leaderboards[leaderboard];

      const ids = Object.values(db)
        .filter(u => u.id && (lbinfo.membership === 'open' || u.leaderboards.includes(leaderboard)))
        .map(u => u.id)
        .filter(id => userData.has(id));


      const { start, end } = lbinfo;
      const bounties = new Set(lbinfo.bounties);

      const entries = ids.map(id => {
        const data = userData.get(id);

        return {
          id,
          name: data.display_name,
          score: calcUserScore(id, start, end, bounties),
        }
      }).sort((a, b) => b.score - a.score);

      // 10 per page, if floating, put target in 6th location

      let skip = (page - 1) * 10;
      if(!page) {
        if(interaction.user.id in db){
          const id = db[interaction.user.id].id;
          const ind = entries.findIndex(entry => entry.id == id);
          if(ind != -1){
            skip = Math.max(0, ind - 5);
          }
        }
      }

      const shown = entries.slice(skip, skip+10);

      const lines = ['Leaderboard:', ...shown.map((e, i) => `${i+skip+1}. ${e.name}   ${e.score.toFixed(1)}`)];

      await interaction.reply({ content: '```\n'+lines.join('\n')+'```', flags: MessageFlags.Ephemeral });
    },
  },
];

// boot up
(async()=>{
  try{
    await Promise.all([updateUserData(), updateProblemData()]);
  } catch {
    // unlucky, wait 10m ig
  };

  const rest = new REST().setToken(config.token);

  if(config.development){
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guild),
      { body: commands.map(c => c.data.toJSON()) },
    );
  }else{
    await rest.put(
      Routes.applicationCommands(config.clientId),
      { body: commands.map(c => c.data.toJSON()) },
    );
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  });

  client.login(config.token);

  client.on(Events.InteractionCreate, async interaction => {
    if(!interaction.isChatInputCommand()) return;
    
    const command = commands.find(c => c.data.name == interaction.commandName);
    
    if(!command) { // never
      await interaction.reply({ content: "What command?", flags: MessageFlags.Ephemeral })
      return;
    }

    try{
      await command.execute(interaction);
    }catch(err){
      console.error(err);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
      }
    }

  })

})();

