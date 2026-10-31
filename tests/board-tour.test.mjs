import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomTour,ROOM_GUIDES} from '../js/reservation-board-model.mjs';

test('default tour runs 1.5 times faster and visits all rooms without input or reservation refresh',()=>{
  const tour=createRoomTour(1000);
  assert.deepEqual([0,5333,10666,15999,21332,26665].map(t=>tour.sample(1000+t).room),['r1','r2','r3','r4','r5','r1']);
  assert.equal(tour.sample(6332).room,'r1');assert.equal(tour.sample(6333).room,'r2');
  // Repeated UI renders must not restart the dwell time.
  for(let t=1000;t<6333;t+=100)tour.sample(t);
  assert.equal(tour.sample(6333).room,'r2');
});
test('manual room selection resumes in order and grants a full new dwell time on that room',()=>{
  const tour=createRoomTour(0);tour.select('r4',3500);
  assert.equal(tour.sample(8832).room,'r4');assert.equal(tour.sample(8833).room,'r5');assert.equal(tour.sample(14166).room,'r1');
  tour.select('invalid',14500);assert.equal(tour.sample(14500).room,'r1');
});
test('pause and resume preserve the current room and remaining time, including manual selection while paused',()=>{
  const tour=createRoomTour(0);tour.pause(6000);
  assert.deepEqual(tour.sample(90000),{room:'r2',progress:667/5333,paused:true});
  tour.resume(100000);assert.equal(tour.sample(104665).room,'r2');assert.equal(tour.sample(104666).room,'r3');
  tour.pause(105000);tour.select('r5',106000);assert.equal(tour.sample(200000).room,'r5');
  tour.resume(200000);assert.equal(tour.sample(205332).room,'r5');assert.equal(tour.sample(205333).room,'r1');
});
test('return from a hidden screen catches up to the schedule and locations distinguish left corridor from right side',()=>{
  const tour=createRoomTour(0);assert.equal(tour.sample(92000).room,'r3');
  assert.equal(ROOM_GUIDES.r5.arrow,'→');assert.equal(ROOM_GUIDES.r5.direction,'오른쪽');
  assert(['r1','r2','r3','r4'].every(id=>ROOM_GUIDES[id].arrow==='←'));
  assert.equal(new Set(Object.values(ROOM_GUIDES).map(g=>g.location)).size,5);
});
