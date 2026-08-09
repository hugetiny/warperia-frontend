import { useCallback } from 'react';
import { debounce } from 'lodash';
import axios from 'axios';
import { WEB_URL } from './../../config.js';

const useDebouncedSearch = (
  setLoading,
  setAddons,
  setTotalPages,
  setCurrentPage,
  selectedCategories,
  activeTab,
  setActiveTab,
  currentPostType,
  selectedSorting
) => {
  const debouncedSearch = useCallback(
    debounce(async (value, pageSize) => {
      let loadingTimeout;
      try {
        loadingTimeout = setTimeout(() => setLoading(true), 300); // Delayed loading state

        if (value.length >= 2) {
          const params = {
            search: value,
            page: 1,
            per_page: pageSize,
            addon_category:
              selectedCategories.length > 0
                ? selectedCategories.map((option) => option.value).join(',')
                : undefined,
            post_type: currentPostType,
          };

          const response = await axios.get(
            `${WEB_URL}/wp-json/wp/v2/addons/search-nested`,
            { params }
          );

          let results = Array.isArray(response.data) ? [...response.data] : [];
          const sortVal = selectedSorting?.value || 'installs';
          const queryLower = value.trim().toLowerCase();

          // Sort search results based on selectedSorting & relevance
          results.sort((a, b) => {
            const titleA = (a.title?.rendered || a.title || '').toLowerCase();
            const titleB = (b.title?.rendered || b.title || '').toLowerCase();

            // Prioritize exact or prefix title match to top
            const exactA = titleA === queryLower || titleA.startsWith(queryLower);
            const exactB = titleB === queryLower || titleB.startsWith(queryLower);
            if (exactA && !exactB) return -1;
            if (!exactA && exactB) return 1;

            if (sortVal === 'installs' || sortVal === 'most-popular') {
              const installsA = parseInt(a.custom_fields?.installs || a.installs || 0, 10);
              const installsB = parseInt(b.custom_fields?.installs || b.installs || 0, 10);
              return installsB - installsA;
            } else if (sortVal === 'rating' || sortVal === 'highest-rated') {
              const ratingA = parseFloat(a.custom_fields?.rating || 0);
              const ratingB = parseFloat(b.custom_fields?.rating || 0);
              return ratingB - ratingA;
            } else if (sortVal === 'title' || sortVal === 'name-asc') {
              return titleA.localeCompare(titleB);
            } else if (sortVal === 'title-desc' || sortVal === 'name-desc') {
              return titleB.localeCompare(titleA);
            } else if (sortVal === 'date' || sortVal === 'recently-updated') {
              return new Date(b.date || b.modified || 0) - new Date(a.date || a.modified || 0);
            }
            return 0;
          });

          setAddons(results);
          setTotalPages(parseInt(response.headers['x-wp-totalpages']) || 1);
          setCurrentPage(1);
        } else if (value.length === 0) {
          clearTimeout(loadingTimeout);
          setLoading(false);
          return;
        }

        if (activeTab !== 'browseAddons') {
          setActiveTab('browseAddons');
        }
      } catch (error) {
        console.error('Error fetching addons:', error);
        setAddons([]);
        setTotalPages(1);
      } finally {
        clearTimeout(loadingTimeout);
        setLoading(false);
      }
    }, 300), // 300ms debounce delay
    [selectedCategories, activeTab, currentPostType, selectedSorting]
  );

  return debouncedSearch;
};

export default useDebouncedSearch;
