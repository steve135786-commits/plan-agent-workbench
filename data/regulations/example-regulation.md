# Example Regulation for Planning Control (SYNTHETIC)

> **This is NOT a real regulation.** It is example text written for the
> PlanAgent Workbench demo so the W1 workflow has something deterministic
> to parse. Every clause number, limit and page below is invented.
> Replace this file with a real public regulation before any production
> use — do not cite these clauses for a real parcel.

Version: 2026-11-16 (synthetic demo, v0.1)

## Chapter 3 — Development intensity and site coverage

### 3.1 General

This chapter sets the quantitative limits for residential parcels in the
R2 land-use class. Limits are stated as maximum or minimum values; a
parcel is screened against each limit in turn. Where a required input
value is not available, the item is marked for human review instead of
being guessed.

### 3.2 Floor area ratio

The floor area ratio of a residential parcel shall not exceed 2.5.
<!-- limit: far_limit = 2.5 | clause 3.2 | page 12 | max -->

### 3.3 Ancillary buildings

Ancillary buildings (guard rooms, bicycle sheds, pump rooms) count toward
the floor area in clause 3.2. No separate limit applies to them in this
chapter.

### 3.4 Building density

The building density of a residential parcel shall not exceed 35%.
<!-- limit: density_limit = 35 | clause 3.4 | page 14 | max -->

### 3.5 Green ratio

The green ratio of a residential parcel shall be no less than 30%.
<!-- limit: green_ratio_min = 30 | clause 3.5 | page 15 | min -->

### 3.6 Building height

The building height of a residential parcel shall not exceed 60 m.
Height is assessed only where a building height value is supplied for
the parcel; where no height value exists, the item is marked for human
review and no height is invented.
<!-- limit: height_limit = 60 | clause 3.6 | page 18 | max -->
