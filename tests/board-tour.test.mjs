import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomTour,ROOM_GUIDES} from '../js/reservation-board-model.mjs';

test('unattended tour visits all rooms and wraps without any input or reservation refresh',()=>{
  const tour=createRoomTour(1000);
  assert.deepEqual([0,8000,16000,24000,32000,40000].map(t=>tour.sample(1000+t).room),['r1','r2','r3','r4','r5','r1']);
  assert.equal(tour.sample(8999).room,'r1');assert.equal(tour.sample(9000).room,'r2');
  // Repeated UI renders must not restart the dwell time.
  for(let t=1000;t<9000;t+=100)tour.sample(t);
  assert.equal(tour.sample(9000).room,'r2');
});
test('manual room selection resumes in order and grants a full eight seconds on that room',()=>{
  const tour=createRoomTour(0);tour.select('r4',3500);
  assert.equal(tour.sample(11499).room,'r4');assert.equal(tour.sample(11500).room,'r5');assert.equal(tour.sample(19500).room,'r1');
  tour.select('invalid',20000);assert.equal(tour.sample(20000).room,'r1');
});
test('pause and resume preserve the current room and remaining time, including manual selection while paused',()=>{
  const tour=createRoomTour(0);tour.pause(11000);
  assert.deepEqual(tour.sample(90000),{room:'r2',progress:3/8,paused:true});
  tour.resume(100000);assert.equal(tour.sample(104999).room,'r2');assert.equal(tour.sample(105000).room,'r3');
  tour.pause(106000);tour.select('r5',107000);assert.equal(tour.sample(200000).room,'r5');
  tour.resume(200000);assert.equal(tour.sample(207999).room,'r5');assert.equal(tour.sample(208000).room,'r1');
});
test('return from a hidden screen catches up to the schedule and locations distinguish left corridor from right side',()=>{
  const tour=createRoomTour(0);assert.equal(tour.sample(92000).room,'r2');
  assert.equal(ROOM_GUIDES.r5.arrow,'→');assert.equal(ROOM_GUIDES.r5.direction,'오른쪽');
  assert(['r1','r2','r3','r4'].every(id=>ROOM_GUIDES[id].arrow==='←'));
  assert.equal(new Set(Object.values(ROOM_GUIDES).map(g=>g.location)).size,5);
});
