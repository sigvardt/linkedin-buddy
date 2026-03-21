/**
 * Test script to run through all major LinkedIn tools to verify selectors and functionality.
 * This runs against the connected profile and uses testAutoConfirm to automatically confirm prepared actions.
 */
import { createCoreRuntime, createDefaultTestAutoConfirmConfig } from "@linkedin-buddy/core";

async function run() {
  console.log("Starting full feature test suite...");
  const runtime = createCoreRuntime({
    testAutoConfirm: { ...createDefaultTestAutoConfirmConfig(), enabled: true }
  });
  
  try {
    const profileName = "default";
    
    console.log("\n1. Testing Profile View");
    try {
      await runtime.profile.viewProfile({ profileName, target: "https://www.linkedin.com/in/me/" });
      console.log("✅ Profile view worked");
    } catch (e: unknown) { console.error("❌ Profile view failed:", (e as Error).message); }

    console.log("\n2. Testing Post Creation");
    try {
      const postPrep = await runtime.posts.prepareCreate({
        profileName,
        text: "Automated test post from test suite.",
        visibility: "public"
      });
      await runtime.twoPhaseCommit.confirmByToken({ confirmToken: postPrep.confirmToken });
      console.log("✅ Post creation worked");
    } catch (e: unknown) { console.error("❌ Post creation failed:", (e as Error).message); }

    console.log("\n3. Testing Newsletter Creation");
    try {
      const newsPrep = await runtime.newsletters.prepareCreate({
        profileName,
        title: "Test Newsletter",
        description: "Test description for automation",
        cadence: "weekly"
      });
      await runtime.twoPhaseCommit.confirmByToken({ confirmToken: newsPrep.confirmToken });
      console.log("✅ Newsletter creation worked");
    } catch (e: unknown) { console.error("❌ Newsletter creation failed:", (e as Error).message); }

    console.log("\n4. Testing Job Alerts");
    try {
      const alertPrep = await runtime.jobs.prepareCreateJobAlert({
        profileName,
        query: "Software Engineer",
        location: "Remote",
        frequency: "daily"
      });
      await runtime.twoPhaseCommit.confirmByToken({ confirmToken: alertPrep.confirmToken });
      console.log("✅ Job alert created");
    } catch (e: unknown) { console.error("❌ Job alert creation failed:", (e as Error).message); }

    console.log("\n5. Testing Groups (Search, Create, Join)");
    try {
      const groupSearch = await runtime.groups.searchGroups({ profileName, query: "Test Group", limit: 1 });
      if (groupSearch.results.length > 0) {
        const joinPrep = await runtime.groups.prepareJoinGroup({ profileName, group: groupSearch.results[0].group_url });
        await runtime.twoPhaseCommit.confirmByToken({ confirmToken: joinPrep.confirmToken });
        console.log("✅ Group join worked");
      }
      
      const createGroup = await runtime.groups.prepareCreateGroup({
        profileName,
        name: "Test Group " + Date.now(),
        description: "Test description"
      });
      await runtime.twoPhaseCommit.confirmByToken({ confirmToken: createGroup.confirmToken });
      console.log("✅ Group creation worked");
    } catch (e: unknown) { console.error("❌ Group tests failed:", (e as Error).message); }

    console.log("\n6. Testing Events (Search, Create, RSVP)");
    try {
      const eventSearch = await runtime.events.searchEvents({ profileName, query: "Tech Meetup", limit: 1 });
      if (eventSearch.results.length > 0) {
        const rsvpPrep = await runtime.events.prepareRsvp({ profileName, event: eventSearch.results[0].event_url });
        await runtime.twoPhaseCommit.confirmByToken({ confirmToken: rsvpPrep.confirmToken });
        console.log("✅ Event RSVP worked");
      }
      
      const createEvent = await runtime.events.prepareCreateEvent({
        profileName,
        name: "Test Event " + Date.now(),
        description: "Test description",
        startDate: "2026-10-10",
        startTime: "10:00",
        endDate: "2026-10-10",
        endTime: "11:00",
        online: true
      });
      await runtime.twoPhaseCommit.confirmByToken({ confirmToken: createEvent.confirmToken });
      console.log("✅ Event creation worked");
    } catch (e: unknown) { console.error("❌ Event tests failed:", (e as Error).message); }

  } finally {
    runtime.close();
  }
}

run().catch(console.error);
