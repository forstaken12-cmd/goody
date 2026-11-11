'use strict';

/** Fake offer catalog used by the demo partner. */
const OFFERS = [
  {
    id: 'dragon',
    name: 'Dragon Farm',
    task: 'Reach level 10',
    category: 'games',
    type: 'install',
    minutes: 20,
    difficulty: 'Easy',
    partnerUsd: 1.2,
    steps: ['Install', 'Open the app', 'Reach level 10'],
    createdAt: '2026-11-01T00:00:00.000Z',
    badge: 'Hot'
  },
  {
    id: 'puzzle',
    name: 'Puzzle Pals',
    task: 'Finish 5 puzzles',
    category: 'games',
    type: 'install',
    minutes: 15,
    difficulty: 'Easy',
    partnerUsd: 1.0,
    steps: ['Install', 'Open the app', 'Finish 5 puzzles'],
    createdAt: '2026-11-03T00:00:00.000Z'
  },
  {
    id: 'chef',
    name: 'Star Chef',
    task: 'Cook 3 recipes',
    category: 'games',
    type: 'install',
    minutes: 30,
    difficulty: 'Hard',
    partnerUsd: 2.4,
    steps: ['Install', 'Open the app', 'Cook 3 recipes'],
    createdAt: '2026-10-20T00:00:00.000Z'
  },
  {
    id: 'rocket',
    name: 'Rocket Racers',
    task: 'Win 1 race',
    category: 'games',
    type: 'install',
    minutes: 15,
    difficulty: 'Medium',
    partnerUsd: 1.5,
    steps: ['Install', 'Open the app', 'Win 1 race'],
    createdAt: '2026-11-05T00:00:00.000Z'
  },
  {
    id: 'bubble',
    name: 'Bubble Buds',
    task: 'Pop 100 bubbles',
    category: 'games',
    type: 'install',
    minutes: 25,
    difficulty: 'Medium',
    partnerUsd: 1.7,
    steps: ['Install', 'Open the app', 'Pop 100 bubbles'],
    createdAt: '2026-11-02T00:00:00.000Z'
  },
  {
    id: 'meow',
    name: 'Meow Music',
    task: 'Play 3 songs',
    category: 'games',
    type: 'install',
    minutes: 10,
    difficulty: 'Easy',
    partnerUsd: 0.8,
    steps: ['Install', 'Open the app', 'Play 3 songs'],
    createdAt: '2026-11-07T00:00:00.000Z',
    badge: 'Quick'
  },
  {
    id: 'newsly',
    name: 'Newsly',
    task: 'Open 5 articles',
    category: 'apps',
    type: 'install',
    minutes: 12,
    difficulty: 'Easy',
    partnerUsd: 0.9,
    steps: ['Install', 'Open the app', 'Open 5 articles'],
    createdAt: '2026-11-06T00:00:00.000Z'
  },
  {
    id: 'fitloop',
    name: 'Fit Loop',
    task: 'Log 1 workout',
    category: 'apps',
    type: 'install',
    minutes: 18,
    difficulty: 'Medium',
    partnerUsd: 1.4,
    steps: ['Install', 'Open the app', 'Log 1 workout'],
    createdAt: '2026-10-28T00:00:00.000Z'
  },
  {
    id: 'tune-town',
    name: 'Tune Town',
    task: 'Play for 30 minutes',
    category: 'games',
    type: 'playtime',
    minutes: 30,
    difficulty: 'Easy',
    partnerUsd: 1.4,
    milestones: [
      { id: 'm5', minutes: 5, partnerUsd: 0.3 },
      { id: 'm15', minutes: 15, partnerUsd: 0.4 },
      { id: 'm30', minutes: 30, partnerUsd: 0.7 }
    ],
    createdAt: '2026-11-08T00:00:00.000Z',
    badge: 'Hot'
  },
  {
    id: 'garden-idle',
    name: 'Garden Idle',
    task: 'Play for 20 minutes',
    category: 'games',
    type: 'playtime',
    minutes: 20,
    difficulty: 'Easy',
    partnerUsd: 0.9,
    milestones: [
      { id: 'm5', minutes: 5, partnerUsd: 0.2 },
      { id: 'm20', minutes: 20, partnerUsd: 0.7 }
    ],
    createdAt: '2026-11-04T00:00:00.000Z'
  },
  {
    id: 'snacks',
    name: 'Snack time',
    task: '4 questions',
    category: 'surveys',
    type: 'survey',
    minutes: 3,
    difficulty: 'Easy',
    partnerUsd: 0.8,
    questions: 4,
    createdAt: '2026-11-08T00:00:00.000Z',
    badge: 'Quick'
  },
  {
    id: 'games-q',
    name: 'Games you like',
    task: '5 questions',
    category: 'surveys',
    type: 'survey',
    minutes: 5,
    difficulty: 'Easy',
    partnerUsd: 1.1,
    questions: 5,
    createdAt: '2026-11-06T00:00:00.000Z'
  },
  {
    id: 'pets',
    name: 'Pets and pals',
    task: '3 questions',
    category: 'surveys',
    type: 'survey',
    minutes: 2,
    difficulty: 'Easy',
    partnerUsd: 0.55,
    questions: 3,
    createdAt: '2026-11-01T00:00:00.000Z'
  },
  {
    id: 'house',
    name: 'Around the house',
    task: '4 questions',
    category: 'surveys',
    type: 'survey',
    minutes: 4,
    difficulty: 'Easy',
    partnerUsd: 0.95,
    questions: 4,
    createdAt: '2026-10-30T00:00:00.000Z'
  }
];

function findOffer(id) {
  return OFFERS.find((o) => o.id === id);
}

function listOffers({ category, sort } = {}) {
  let list = OFFERS.slice();
  if (category && category !== 'all') {
    const want = category.toLowerCase();
    list = list.filter((o) => o.category === want);
  }
  if (sort === 'quickest') {
    list.sort((a, b) => a.minutes - b.minutes || b.partnerUsd - a.partnerUsd);
  } else if (sort === 'newest') {
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } else {
    // highest pay (default)
    list.sort((a, b) => b.partnerUsd - a.partnerUsd || a.minutes - b.minutes);
  }
  return list;
}

module.exports = { OFFERS, findOffer, listOffers };
