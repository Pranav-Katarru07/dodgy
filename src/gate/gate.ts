// Gate page entry stub. Reads ?target and will render chase/guilt/lockout.
const params = new URLSearchParams(location.search);
const target = params.get('target');
console.debug('[dodgy] gate loaded, target =', target);
